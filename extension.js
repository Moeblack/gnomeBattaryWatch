import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Cairo from 'cairo';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const BATTERY_PATH = '/sys/class/power_supply/BAT0';
const HISTORY_DIR = 'power-energy-monitor';
const HISTORY_FILE = 'history.json';
const HISTORY_VERSION = 2;
const CHART_WIDTH = 320;
const CHART_HEIGHT = 150;
const WRITE_DEBOUNCE_SECONDS = 5;
const MENU_REPAINT_SECONDS = 3;
const POWER_EWMA_HALF_LIFE_SECONDS = 90;
const STATE_CONFIRM_SAMPLES = 3;
const TIME_GAP_MULTIPLIER = 3;
const MIN_SEGMENT_SECONDS = 10 * 60;
const MIN_SEGMENT_CAPACITY_RATIO = 0.02;
const MIN_PREDICTION_POWER_W = 0.05;
const ENERGY_DIRECTION_EPSILON_WH = 0.002;
const RECENT_RATIO_SECONDS = 7 * 24 * 60 * 60;
const RECENT_RATIO_LIMIT = 80;

const TIME_RANGES = {
    '5m': 5 * 60,
    '15m': 15 * 60,
    '1h': 60 * 60,
    '5h': 5 * 60 * 60,
    '12h': 12 * 60 * 60,
    '1d': 24 * 60 * 60,
    '3d': 3 * 24 * 60 * 60,
    '1w': 7 * 24 * 60 * 60,
};

const RANGE_LABELS = [
    ['5m', '5 分钟'],
    ['15m', '15 分钟'],
    ['1h', '1 小时'],
    ['5h', '5 小时'],
    ['12h', '12 小时'],
    ['1d', '1 天'],
    ['3d', '3 天'],
    ['1w', '1 周'],
    ['custom', '自定义'],
];

const VIEW_LABELS = [
    ['power', '功率 (W)'],
    ['energy', '余电'],
    ['remaining', '剩余时间'],
];

function clamp(value, lower, upper) {
    return Math.min(Math.max(value, lower), upper);
}

function decodeBytes(bytes) {
    return new TextDecoder().decode(bytes).trim();
}

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function isPredictionKind(kind) {
    return kind === 'discharge' || kind === 'charge';
}

const Indicator = GObject.registerClass(
class PowerEnergyIndicator extends PanelMenu.Button {
    _init(extension) {
        // 查证结果：GNOME Shell 50 的 PanelMenu.Button 构造参数仍然是
        // (menuAlignment, nameText, dontCreateMenu)。
        super._init(0.0, 'Power & Energy Monitor', false);

        this._extension = extension;
        this._signals = [];
        this._viewItems = new Map();
        this._rangeItems = new Map();
        this._viewSubMenu = null;
        this._rangeSubMenu = null;
        this._chartNoteItem = null;
        this._estimateItem = null;
        this._menuTimeoutId = 0;

        const box = new St.BoxLayout({
            style_class: 'power-energy-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._powerIcon = new St.Icon({
            icon_name: 'ac-adapter-symbolic',
            style_class: 'system-status-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._powerLabel = new St.Label({
            text: '-- W',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._batteryIcon = new St.Icon({
            icon_name: 'battery-missing-symbolic',
            style_class: 'system-status-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._energyLabel = new St.Label({
            text: '-- Wh',
            y_align: Clutter.ActorAlign.CENTER,
        });

        box.add_child(this._powerIcon);
        box.add_child(this._powerLabel);
        box.add_child(this._batteryIcon);
        box.add_child(this._energyLabel);
        this.add_child(box);

        this._buildMenu();
        this.updateValues(null);
    }

    _buildMenu() {
        this._summaryItem = new PopupMenu.PopupMenuItem('数据采集中...', {
            reactive: false,
            can_focus: false,
        });
        this._summaryItem.setSensitive(false);
        this.menu.addMenuItem(this._summaryItem);

        this._estimateItem = new PopupMenu.PopupMenuItem('预计时间：计算中', {
            reactive: false,
            can_focus: false,
        });
        this._estimateItem.setSensitive(false);
        this.menu.addMenuItem(this._estimateItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const chartItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._chartArea = new St.DrawingArea({
            style_class: 'power-energy-chart',
            width: CHART_WIDTH,
            height: CHART_HEIGHT,
        });
        this._chartArea.set_size(CHART_WIDTH, CHART_HEIGHT);
        chartItem.add_child(this._chartArea);
        this.menu.addMenuItem(chartItem);

        this._signals.push([
            this._chartArea,
            this._chartArea.connect('repaint', area => {
                this._extension.drawChart(area);
            }),
        ]);

        this._chartNoteItem = new PopupMenu.PopupMenuItem(
            '实际数据将在一段完整的放电或者充电结束后出现',
            {
                reactive: false,
                can_focus: false,
            });
        this._chartNoteItem.setSensitive(false);
        this.menu.addMenuItem(this._chartNoteItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._viewSubMenu = new PopupMenu.PopupSubMenuMenuItem('图表视图');
        this.menu.addMenuItem(this._viewSubMenu);
        for (const [view, label] of VIEW_LABELS) {
            const item = new PopupMenu.PopupMenuItem(label);
            this._signals.push([
                item,
                item.connect('activate', () => this._extension.setCurrentView(view)),
            ]);
            this._viewItems.set(view, item);
            this._viewSubMenu.menu.addMenuItem(item);
        }

        this._rangeSubMenu = new PopupMenu.PopupSubMenuMenuItem('时间范围');
        this.menu.addMenuItem(this._rangeSubMenu);
        for (const [range, label] of RANGE_LABELS) {
            const item = new PopupMenu.PopupMenuItem(label);
            this._signals.push([
                item,
                item.connect('activate', () => this._extension.setCurrentTimeRange(range)),
            ]);
            this._rangeItems.set(range, item);
            this._rangeSubMenu.menu.addMenuItem(item);
        }

        this._signals.push([
            this.menu,
            this.menu.connect('open-state-changed', (menu, open) => {
                if (open) {
                    this.queueChartRepaint();
                    this._startMenuRepaintTimer();
                } else {
                    this._stopMenuRepaintTimer();
                }
            }),
        ]);

        this.syncMenuState();
    }

    _startMenuRepaintTimer() {
        this._stopMenuRepaintTimer();
        this._menuTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            MENU_REPAINT_SECONDS,
            () => {
                this.queueChartRepaint();
                return true;
            });
    }

    _stopMenuRepaintTimer() {
        if (this._menuTimeoutId) {
            GLib.Source.remove(this._menuTimeoutId);
            this._menuTimeoutId = 0;
        }
    }

    _disconnectSignals() {
        for (const [object, signalId] of this._signals) {
            try {
                object.disconnect(signalId);
            } catch (error) {
                console.error('Power & Energy Monitor: failed to disconnect signal', error);
            }
        }
        this._signals = [];
    }

    syncMenuState() {
        if (this._viewSubMenu)
            this._viewSubMenu.label.text = `图表视图：${this._extension.viewLabel(this._extension.currentView)}`;
        if (this._rangeSubMenu)
            this._rangeSubMenu.label.text = `时间范围：${this._extension.rangeLabel(this._extension.currentTimeRange)}`;

        for (const [view, item] of this._viewItems) {
            item.setOrnament(view === this._extension.currentView
                ? PopupMenu.Ornament.DOT
                : PopupMenu.Ornament.NONE);
        }
        for (const [range, item] of this._rangeItems) {
            item.setOrnament(range === this._extension.currentTimeRange
                ? PopupMenu.Ornament.DOT
                : PopupMenu.Ornament.NONE);
        }

        this._syncChartNoteVisibility();
    }

    _syncChartNoteVisibility() {
        if (!this._chartNoteItem)
            return;

        this._chartNoteItem.visible = this._extension.currentView === 'remaining' &&
            !this._extension.hasActualTimeDataForCurrentRange();
    }

    queueChartRepaint() {
        this._chartArea?.queue_repaint();
    }

    updateValues(sample) {
        if (!sample) {
            this._powerLabel.text = '-- W';
            this._energyLabel.text = '-- Wh';
            this._batteryIcon.icon_name = 'battery-missing-symbolic';
            this._summaryItem.label.text = '数据采集中...';
            this._estimateItem.label.text = '预计时间：计算中';
            this._syncChartNoteVisibility();
            return;
        }

        this._powerLabel.text = this._extension.formatPanelPower(sample.powerW, sample.status);
        this._energyLabel.text = isFiniteNumber(sample.energyWh)
            ? `${sample.energyWh.toFixed(1)} Wh`
            : '-- Wh';
        this._batteryIcon.icon_name = this._extension.batteryIconName(
            sample.status,
            sample.capacity);

        const status = this._extension.statusLabel(sample.status);
        const capacity = Number.isFinite(sample.capacity) ? `${sample.capacity}%` : '--%';
        this._summaryItem.label.text = [
            status,
            capacity,
            this._powerLabel.text,
            this._energyLabel.text,
        ].join(' · ');
        this._estimateItem.label.text = this._extension.estimateSummary(sample);
        this._syncChartNoteVisibility();
    }

    destroy() {
        this._stopMenuRepaintTimer();
        this._disconnectSignals();
        this._chartArea = null;
        this._summaryItem = null;
        this._estimateItem = null;
        this._chartNoteItem = null;
        this._viewSubMenu = null;
        this._rangeSubMenu = null;
        this._viewItems.clear();
        this._rangeItems.clear();
        super.destroy();
    }
});

export default class PowerEnergyMonitorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settingsSignals = [];
        this._timeoutId = 0;
        this._writeTimeoutId = 0;
        this._rawData = [];
        this._midData = [];
        this._coarseData = [];
        this._actualTimeData = [];
        this._lastSample = null;
        this._lastPredictionRecord = null;
        this._smoothPower = {charge: NaN, discharge: NaN};
        this._confirmedPredictionKind = null;
        this._pendingPredictionKind = null;
        this._pendingPredictionRecords = [];
        this._activeTimeSegment = null;
        this._lastMidBucket = -1;
        this._lastCoarseBucket = -1;
        this._currentView = this._settings.get_string('default-view');
        this._currentTimeRange = this._settings.get_string('default-time-range');
        this._historyPath = this._buildHistoryPath();

        this._loadHistory();
        this._recalculateAggregateBuckets();
        this._rebuildPredictionRuntimeState();
        const now = this._nowSeconds();
        const changed = this._downsample(now) || this._pruneData(now);
        if (changed)
            this._scheduleHistoryWrite();

        this._indicator = new Indicator(this);
        this._addIndicatorToPanel();
        this._connectSettings();
        this._update();
        this._startSampler();
    }

    disable() {
        this._stopSampler();

        if (this._writeTimeoutId) {
            GLib.Source.remove(this._writeTimeoutId);
            this._writeTimeoutId = 0;
        }
        this._writeHistoryNow();

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        if (this._settings) {
            for (const signalId of this._settingsSignals)
                this._settings.disconnect(signalId);
        }

        this._settingsSignals = [];
        this._settings = null;
        this._rawData = [];
        this._midData = [];
        this._coarseData = [];
        this._actualTimeData = [];
        this._lastSample = null;
        this._lastPredictionRecord = null;
        this._smoothPower = {charge: NaN, discharge: NaN};
        this._confirmedPredictionKind = null;
        this._pendingPredictionKind = null;
        this._pendingPredictionRecords = [];
        this._activeTimeSegment = null;
    }

    get currentView() {
        return this._currentView;
    }

    get currentTimeRange() {
        return this._currentTimeRange;
    }

    viewLabel(view) {
        return VIEW_LABELS.find(([value]) => value === view)?.[1] ?? view;
    }

    rangeLabel(range) {
        return RANGE_LABELS.find(([value]) => value === range)?.[1] ?? range;
    }

    estimateSummary(sample) {
        const record = this._lastPredictionRecord;
        if (!sample ||
            !record ||
            record.t !== sample.t ||
            !isPredictionKind(record.kind) ||
            !isFiniteNumber(record.estimate)) {
            return '预计时间：计算中';
        }

        const prefix = record.kind === 'discharge' ? '预计剩余' : '预计充满';
        let text = `${prefix}：${this._formatDurationWords(record.estimate)}`;
        const ratio = this._recentAverageRatio(record.kind);
        if (isFiniteNumber(ratio))
            text += `（近期实际/预测 ≈ ${ratio.toFixed(2)}）`;
        return text;
    }

    hasActualTimeDataForCurrentRange() {
        const rangeSeconds = this._rangeSeconds(this._currentTimeRange);
        const cutoff = this._nowSeconds() - rangeSeconds;
        let count = 0;
        for (const record of this._actualTimeData) {
            if (record.t >= cutoff) {
                count++;
                if (count >= 2)
                    return true;
            }
        }
        return false;
    }

    _recentAverageRatio(kind) {
        const cutoff = this._nowSeconds() - RECENT_RATIO_SECONDS;
        const ratios = this._actualTimeData
            .filter(record =>
                record.t >= cutoff &&
                (!kind || record.kind === kind) &&
                isFiniteNumber(record.ratio) &&
                record.ratio > 0)
            .slice(-RECENT_RATIO_LIMIT)
            .map(record => record.ratio);

        if (!ratios.length)
            return NaN;

        return ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
    }

    _addIndicatorToPanel() {
        // 查证结果：Main.panel.addToStatusArea(role, indicator, position, box)
        // 的 box 参数接受 left、center、right；这里用 left 和索引 1 紧邻“活动”。
        const box = Main.panel?._leftBox ? 'left' : 'right';
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, box);
    }

    _connectSettings() {
        this._settingsSignals.push(this._settings.connect(
            'changed::sample-interval-seconds',
            () => this._restartSampler()));

        for (const key of [
            'raw-retention-hours',
            'mid-retention-days',
            'coarse-retention-days',
        ]) {
            this._settingsSignals.push(this._settings.connect(`changed::${key}`, () => {
                if (this._pruneData(this._nowSeconds()))
                    this._scheduleHistoryWrite();
                this._indicator?.queueChartRepaint();
            }));
        }

        this._settingsSignals.push(this._settings.connect('changed::default-view', () => {
            this._currentView = this._settings.get_string('default-view');
            this._indicator?.syncMenuState();
            this._indicator?.queueChartRepaint();
        }));

        this._settingsSignals.push(this._settings.connect('changed::default-time-range', () => {
            this._currentTimeRange = this._settings.get_string('default-time-range');
            this._indicator?.syncMenuState();
            this._indicator?.queueChartRepaint();
        }));

        for (const key of ['chart-color', 'custom-range-value', 'custom-range-unit']) {
            this._settingsSignals.push(this._settings.connect(`changed::${key}`, () => {
                this._indicator?.queueChartRepaint();
            }));
        }

        this._settingsSignals.push(this._settings.connect('changed::persist-to-disk', () => {
            if (this._settings.get_boolean('persist-to-disk')) {
                this._scheduleHistoryWrite();
            } else if (this._writeTimeoutId) {
                GLib.Source.remove(this._writeTimeoutId);
                this._writeTimeoutId = 0;
            }
        }));
    }

    _startSampler() {
        const interval = clamp(this._settings.get_int('sample-interval-seconds'), 1, 60);
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._update();
            return true;
        });
    }

    _stopSampler() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    _restartSampler() {
        this._stopSampler();
        this._startSampler();
    }

    _update() {
        const sample = this._readBatterySample();
        if (!sample) {
            this._indicator?.updateValues(this._lastSample);
            return;
        }

        const hadTimeGap = this._hasTimeGap(this._lastPredictionRecord, sample.t);
        const {record, kind} = this._createRawRecord(sample, hadTimeGap);
        this._rawData.push(record);
        const backfillChanged = this._processPredictionRecord(
            record,
            kind,
            sample,
            hadTimeGap);
        this._lastPredictionRecord = record;
        this._lastSample = sample;

        const downsampleChanged = this._downsample(sample.t);
        const pruneChanged = this._pruneData(sample.t);
        const rawChanged = true;
        const changed = rawChanged || backfillChanged || downsampleChanged || pruneChanged;
        if (changed)
            this._scheduleHistoryWrite();

        this._indicator?.updateValues(sample);
        if (this._indicator?.menu?.isOpen)
            this._indicator.queueChartRepaint();
    }

    _readBatterySample() {
        const now = this._nowSeconds();
        const powerRaw = Number.parseInt(this._readSys('power_now'), 10);
        const energyRaw = Number.parseInt(this._readSys('energy_now'), 10);
        const energyFullRaw = Number.parseInt(this._readSys('energy_full'), 10);
        const capacity = Number.parseInt(this._readSys('capacity'), 10);
        const status = this._readSys('status');

        if (!Number.isFinite(powerRaw) && !Number.isFinite(energyRaw))
            return null;

        const powerW = Number.isFinite(powerRaw) ? powerRaw / 1_000_000 : 0;
        const energyFullWh = Number.isFinite(energyFullRaw)
            ? energyFullRaw / 1_000_000
            : NaN;
        let energyWh = Number.isFinite(energyRaw) ? energyRaw / 1_000_000 : NaN;

        if (!Number.isFinite(energyWh) &&
            Number.isFinite(energyFullWh) &&
            Number.isFinite(capacity)) {
            energyWh = energyFullWh * clamp(capacity, 0, 100) / 100;
        }

        if (!Number.isFinite(energyWh))
            return null;

        return {
            t: now,
            powerW,
            energyWh,
            energyFullWh,
            capacity: Number.isFinite(capacity) ? clamp(capacity, 0, 100) : NaN,
            status,
        };
    }

    _readSys(name) {
        try {
            const [ok, bytes] = GLib.file_get_contents(`${BATTERY_PATH}/${name}`);
            return ok ? decodeBytes(bytes) : '';
        } catch (error) {
            return '';
        }
    }

    _createRawRecord(sample, hadTimeGap) {
        if (hadTimeGap)
            this._resetPowerSmoothing();

        const previousRecord = this._lastPredictionRecord;
        const kind = this._inferPredictionKind(sample, previousRecord, hadTimeGap);
        let smoothPowerW = NaN;

        if (isPredictionKind(kind)) {
            if (sample.status === 'Full') {
                smoothPowerW = this._smoothPower.charge;
            } else {
                const dt = previousRecord
                    ? sample.t - previousRecord.t
                    : this._sampleIntervalSeconds();
                smoothPowerW = this._updateSmoothPower(kind, Math.abs(sample.powerW), dt);
            }
        }

        const estimateSeconds = this._estimateSeconds(sample, kind, smoothPowerW);
        const record = {
            t: sample.t,
            p: Number(sample.powerW.toFixed(2)),
            e: Number(sample.energyWh.toFixed(1)),
        };

        if (isFiniteNumber(sample.energyFullWh))
            record.ef = Number(sample.energyFullWh.toFixed(1));
        if (sample.status)
            record.status = sample.status;
        if (isPredictionKind(kind))
            record.kind = kind;
        if (isFiniteNumber(smoothPowerW))
            record.smooth = Number(smoothPowerW.toFixed(2));
        if (isFiniteNumber(estimateSeconds))
            record.estimate = Math.max(0, Math.round(estimateSeconds));

        return {record, kind};
    }

    _inferPredictionKind(sample, previousRecord, hadTimeGap) {
        if (sample.status === 'Discharging')
            return 'discharge';
        if (sample.status === 'Charging' || sample.status === 'Full')
            return 'charge';

        if (!['Unknown', 'Not charging', ''].includes(sample.status))
            return null;

        if (!previousRecord || hadTimeGap || !isFiniteNumber(previousRecord.e))
            return null;

        const deltaWh = sample.energyWh - previousRecord.e;
        if (deltaWh > ENERGY_DIRECTION_EPSILON_WH)
            return 'charge';
        if (deltaWh < -ENERGY_DIRECTION_EPSILON_WH)
            return 'discharge';
        return null;
    }

    _updateSmoothPower(kind, powerW, dt) {
        const value = Math.max(0, powerW);
        const previous = this._smoothPower[kind];

        if (!isFiniteNumber(previous)) {
            this._smoothPower[kind] = value;
            return value;
        }

        const elapsed = Math.max(1, dt);
        const alpha = 1 - Math.pow(0.5, elapsed / POWER_EWMA_HALF_LIFE_SECONDS);
        const smooth = alpha * value + (1 - alpha) * previous;
        this._smoothPower[kind] = smooth;
        return smooth;
    }

    _estimateSeconds(sample, kind, smoothPowerW) {
        if (!isPredictionKind(kind))
            return NaN;
        if (sample.status === 'Full')
            return 0;
        if (!isFiniteNumber(smoothPowerW) || smoothPowerW < MIN_PREDICTION_POWER_W)
            return NaN;

        if (kind === 'discharge') {
            if (!isFiniteNumber(sample.energyWh) || sample.energyWh <= 0)
                return NaN;
            return sample.energyWh / smoothPowerW * 60 * 60;
        }

        if (!isFiniteNumber(sample.energyFullWh) || !isFiniteNumber(sample.energyWh))
            return NaN;

        const remainingWh = Math.max(0, sample.energyFullWh - sample.energyWh);
        if (remainingWh <= ENERGY_DIRECTION_EPSILON_WH)
            return 0;
        return remainingWh / smoothPowerW * 60 * 60;
    }

    _processPredictionRecord(record, kind, sample, hadTimeGap) {
        let changed = false;

        if (hadTimeGap) {
            if (this._activeTimeSegment)
                changed = this._finishTimeSegment(this._activeTimeSegment, this._lastPredictionRecord) || changed;
            this._resetPredictionSegmentState();
        }

        if (sample.status === 'Full' && this._activeTimeSegment?.kind === 'charge') {
            changed = this._finishTimeSegment(this._activeTimeSegment, record) || changed;
            this._resetPredictionSegmentState();
            this._confirmedPredictionKind = 'charge';
            return changed;
        }

        return this._applyPredictionKind(record, kind) || changed;
    }

    _applyPredictionKind(record, kind) {
        if (kind === this._confirmedPredictionKind) {
            this._pendingPredictionKind = null;
            this._pendingPredictionRecords = [];
            this._appendSegmentRecord(record, kind);
            return false;
        }

        if (this._pendingPredictionKind !== kind) {
            this._pendingPredictionKind = kind;
            this._pendingPredictionRecords = [record];
        } else {
            this._pendingPredictionRecords.push(record);
        }

        if (this._pendingPredictionRecords.length < STATE_CONFIRM_SAMPLES)
            return false;

        const boundaryRecord = this._pendingPredictionRecords[0];
        let changed = false;
        if (this._activeTimeSegment)
            changed = this._finishTimeSegment(this._activeTimeSegment, boundaryRecord) || changed;

        const confirmedKind = this._pendingPredictionKind;
        const confirmedRecords = this._pendingPredictionRecords;
        this._resetPredictionSegmentState();
        this._confirmedPredictionKind = confirmedKind;

        if (isPredictionKind(confirmedKind)) {
            for (const pendingRecord of confirmedRecords)
                this._appendSegmentRecord(pendingRecord, confirmedKind);
        }

        return changed;
    }

    _appendSegmentRecord(record, kind) {
        if (!isPredictionKind(kind) || record.status === 'Full')
            return;

        if (!this._activeTimeSegment || this._activeTimeSegment.kind !== kind) {
            this._activeTimeSegment = {
                kind,
                samples: [],
            };
        }

        this._activeTimeSegment.samples.push(record);
    }

    _finishTimeSegment(segment, endRecord) {
        if (!segment?.samples?.length || !endRecord)
            return false;

        const samples = segment.samples
            .filter(record => record.t <= endRecord.t)
            .sort((a, b) => a.t - b.t);
        if (!samples.length)
            return false;

        const startRecord = samples[0];
        const durationSeconds = endRecord.t - startRecord.t;
        if (durationSeconds < MIN_SEGMENT_SECONDS)
            return false;

        const movedWh = this._movedEnergyWh(segment.kind, startRecord.e, endRecord.e);
        const fullWh = this._segmentFullEnergyWh(samples, endRecord);
        if (!isFiniteNumber(fullWh) ||
            movedWh < fullWh * MIN_SEGMENT_CAPACITY_RATIO)
            return false;

        let appended = 0;
        for (const record of samples) {
            const actualSeconds = endRecord.t - record.t;
            if (actualSeconds <= 0)
                continue;

            const energyWh = this._movedEnergyWh(segment.kind, record.e, endRecord.e);
            if (energyWh <= 0)
                continue;

            const smoothPowerW = Number(record.smooth);
            if (!isFiniteNumber(smoothPowerW) || smoothPowerW < MIN_PREDICTION_POWER_W)
                continue;

            const predictedSeconds = energyWh / smoothPowerW * 60 * 60;
            if (!isFiniteNumber(predictedSeconds) || predictedSeconds <= 0)
                continue;

            const ratio = actualSeconds / predictedSeconds;
            if (!isFiniteNumber(ratio) || ratio <= 0)
                continue;

            this._actualTimeData.push({
                t: record.t,
                actual: Math.round(actualSeconds),
                ratio: Number(ratio.toFixed(3)),
                kind: segment.kind,
            });
            appended++;
        }

        if (appended > 0) {
            this._actualTimeData = this._normalizeActualRecords(this._actualTimeData);
            return true;
        }

        return false;
    }

    _movedEnergyWh(kind, fromWh, toWh) {
        if (!isFiniteNumber(fromWh) || !isFiniteNumber(toWh))
            return 0;
        if (kind === 'discharge')
            return Math.max(0, fromWh - toWh);
        return Math.max(0, toWh - fromWh);
    }

    _segmentFullEnergyWh(samples, endRecord) {
        const values = [endRecord, ...samples]
            .map(record => Number(record.ef))
            .filter(isFiniteNumber);
        if (!values.length)
            return NaN;
        return Math.max(...values);
    }

    _resetPowerSmoothing() {
        this._smoothPower = {charge: NaN, discharge: NaN};
    }

    _resetPredictionSegmentState() {
        this._confirmedPredictionKind = null;
        this._pendingPredictionKind = null;
        this._pendingPredictionRecords = [];
        this._activeTimeSegment = null;
    }

    _hasTimeGap(previousRecord, timestamp) {
        if (!previousRecord)
            return false;
        return timestamp - previousRecord.t >
            this._sampleIntervalSeconds() * TIME_GAP_MULTIPLIER;
    }

    _sampleIntervalSeconds() {
        if (!this._settings)
            return 5;
        return clamp(this._settings.get_int('sample-interval-seconds'), 1, 60);
    }

    _downsample(now) {
        const rawChanged = this._downsampleRaw(now);
        const midChanged = this._downsampleMid(now);
        return rawChanged || midChanged;
    }

    _downsampleRaw(now) {
        const buckets = this._completedBuckets(this._rawData, 60, now, this._lastMidBucket);
        let changed = false;

        for (const [bucket, samples] of buckets) {
            if (samples.length >= 2) {
                this._midData.push(this._aggregate(samples, bucket));
                changed = true;
            }
            this._lastMidBucket = Math.max(this._lastMidBucket, bucket);
        }

        return changed;
    }

    _downsampleMid(now) {
        const buckets = this._completedBuckets(this._midData, 60 * 60, now, this._lastCoarseBucket);
        let changed = false;

        for (const [bucket, samples] of buckets) {
            if (samples.length >= 2) {
                this._coarseData.push(this._aggregate(samples, bucket));
                changed = true;
            }
            this._lastCoarseBucket = Math.max(this._lastCoarseBucket, bucket);
        }

        return changed;
    }

    _completedBuckets(data, bucketSize, now, lastBucket) {
        const map = new Map();

        for (const record of data) {
            const bucket = Math.floor(record.t / bucketSize) * bucketSize;
            if (bucket <= lastBucket || bucket + bucketSize > now)
                continue;

            if (!map.has(bucket))
                map.set(bucket, []);
            map.get(bucket).push(record);
        }

        return [...map.entries()].sort((a, b) => a[0] - b[0]);
    }

    _aggregate(samples, bucket) {
        const sorted = [...samples].sort((a, b) => a.t - b.t);
        const power = sorted.reduce((sum, record) => sum + record.p, 0) / sorted.length;
        const last = sorted[sorted.length - 1];

        return {
            t: bucket,
            p: Number(power.toFixed(2)),
            e: Number(last.e.toFixed(1)),
        };
    }

    _pruneData(now) {
        let changed = false;

        changed = this._pruneArray(
            this._rawData,
            this._settings.get_int('raw-retention-hours') * 60 * 60,
            now) || changed;
        changed = this._pruneArray(
            this._midData,
            this._settings.get_int('mid-retention-days') * 24 * 60 * 60,
            now) || changed;
        changed = this._pruneArray(
            this._coarseData,
            this._settings.get_int('coarse-retention-days') * 24 * 60 * 60,
            now) || changed;
        changed = this._pruneArray(
            this._actualTimeData,
            this._actualRetentionSeconds(),
            now) || changed;

        return changed;
    }

    _actualRetentionSeconds() {
        const values = [
            this._settings.get_int('raw-retention-hours') * 60 * 60,
            this._settings.get_int('mid-retention-days') * 24 * 60 * 60,
            this._settings.get_int('coarse-retention-days') * 24 * 60 * 60,
        ];

        if (values.some(value => value === 0))
            return 0;

        return Math.max(...values);
    }

    _pruneArray(data, retentionSeconds, now) {
        if (retentionSeconds === 0)
            return false;

        const cutoff = now - retentionSeconds;
        const firstKept = data.findIndex(record => record.t >= cutoff);
        if (firstKept === 0)
            return false;
        if (firstKept === -1) {
            const hadRecords = data.length > 0;
            data.splice(0, data.length);
            return hadRecords;
        }

        data.splice(0, firstKept);
        return true;
    }

    _loadHistory() {
        if (!this._settings.get_boolean('persist-to-disk'))
            return;

        try {
            const [ok, bytes] = GLib.file_get_contents(this._historyPath);
            if (!ok)
                return;

            const history = JSON.parse(decodeBytes(bytes));
            const version = Number(history.version) || 1;
            this._rawData = this._normalizeRawRecords(history.raw);
            this._midData = this._normalizeRecords(history.mid);
            this._coarseData = this._normalizeRecords(history.coarse);
            this._actualTimeData = version >= 2
                ? this._normalizeActualRecords(history.actual)
                : [];
        } catch (error) {
            this._rawData = [];
            this._midData = [];
            this._coarseData = [];
            this._actualTimeData = [];
        }
    }

    _normalizeRawRecords(records) {
        if (!Array.isArray(records))
            return [];

        return records
            .map(record => {
                const normalized = {
                    t: Number(record.t),
                    p: Number(record.p),
                    e: Number(record.e),
                };

                const energyFullWh = Number(record.ef);
                const smoothPowerW = Number(record.smooth);
                const estimateSeconds = Number(record.estimate);
                if (isFiniteNumber(energyFullWh))
                    normalized.ef = energyFullWh;
                if (typeof record.status === 'string')
                    normalized.status = record.status;
                if (isPredictionKind(record.kind))
                    normalized.kind = record.kind;
                if (isFiniteNumber(smoothPowerW))
                    normalized.smooth = smoothPowerW;
                if (isFiniteNumber(estimateSeconds))
                    normalized.estimate = estimateSeconds;

                return normalized;
            })
            .filter(record =>
                Number.isFinite(record.t) &&
                Number.isFinite(record.p) &&
                Number.isFinite(record.e))
            .sort((a, b) => a.t - b.t);
    }

    _normalizeRecords(records) {
        if (!Array.isArray(records))
            return [];

        return records
            .map(record => ({
                t: Number(record.t),
                p: Number(record.p),
                e: Number(record.e),
            }))
            .filter(record =>
                Number.isFinite(record.t) &&
                Number.isFinite(record.p) &&
                Number.isFinite(record.e))
            .sort((a, b) => a.t - b.t);
    }

    _normalizeActualRecords(records) {
        if (!Array.isArray(records))
            return [];

        const normalized = records
            .map(record => ({
                t: Number(record.t),
                actual: Number(record.actual),
                ratio: Number(record.ratio),
                kind: record.kind,
            }))
            .filter(record =>
                Number.isFinite(record.t) &&
                Number.isFinite(record.actual) &&
                Number.isFinite(record.ratio) &&
                record.actual >= 0 &&
                record.ratio > 0 &&
                isPredictionKind(record.kind))
            .sort((a, b) => a.t - b.t);

        const deduped = new Map();
        for (const record of normalized)
            deduped.set(`${record.kind}:${record.t}`, record);
        return [...deduped.values()].sort((a, b) => a.t - b.t);
    }

    _scheduleHistoryWrite() {
        if (!this._settings?.get_boolean('persist-to-disk'))
            return;

        if (this._writeTimeoutId)
            GLib.Source.remove(this._writeTimeoutId);

        this._writeTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            WRITE_DEBOUNCE_SECONDS,
            () => {
                this._writeTimeoutId = 0;
                this._writeHistoryNow();
                return false;
            });
    }

    _writeHistoryNow() {
        if (!this._settings?.get_boolean('persist-to-disk'))
            return;

        try {
            const dir = GLib.path_get_dirname(this._historyPath);
            GLib.mkdir_with_parents(dir, 0o755);
            const payload = JSON.stringify({
                version: HISTORY_VERSION,
                raw: this._rawData,
                mid: this._midData,
                coarse: this._coarseData,
                actual: this._actualTimeData,
            });

            // 查证结果：Gio.File.replace_contents 可用；这里按照需求使用
            // GLib.file_set_contents 同步写入这个 JSON 快照，代码更直接。
            GLib.file_set_contents(this._historyPath, payload);
        } catch (error) {
            console.error('Power & Energy Monitor: failed to write history', error);
        }
    }

    _buildHistoryPath() {
        return GLib.build_filenamev([
            GLib.get_user_config_dir(),
            HISTORY_DIR,
            HISTORY_FILE,
        ]);
    }

    _recalculateAggregateBuckets() {
        this._lastMidBucket = this._maxBucket(this._midData, 60);
        this._lastCoarseBucket = this._maxBucket(this._coarseData, 60 * 60);
    }

    _maxBucket(data, bucketSize) {
        if (!data.length)
            return -1;

        let max = -1;
        for (const record of data)
            max = Math.max(max, Math.floor(record.t / bucketSize) * bucketSize);
        return max;
    }

    _rebuildPredictionRuntimeState() {
        this._resetPowerSmoothing();
        this._resetPredictionSegmentState();
        this._lastPredictionRecord = this._rawData.length
            ? this._rawData[this._rawData.length - 1]
            : null;

        for (const record of this._rawData) {
            if (isPredictionKind(record.kind) && isFiniteNumber(record.smooth))
                this._smoothPower[record.kind] = record.smooth;
        }

        if (!this._rawData.length)
            return;

        const lastRecord = this._rawData[this._rawData.length - 1];
        if (!isPredictionKind(lastRecord.kind)) {
            this._confirmedPredictionKind = null;
            return;
        }

        this._confirmedPredictionKind = lastRecord.kind;
        if (lastRecord.status === 'Full')
            return;

        const latestActualTime = this._actualTimeData.length
            ? this._actualTimeData[this._actualTimeData.length - 1].t
            : -1;
        const tail = [];
        for (let i = this._rawData.length - 1; i >= 0; i--) {
            const record = this._rawData[i];
            const nextRecord = tail[0] ?? null;
            if (record.t <= latestActualTime ||
                record.kind !== lastRecord.kind ||
                record.status === 'Full')
                break;
            if (nextRecord && this._hasTimeGap(record, nextRecord.t))
                break;
            tail.unshift(record);
        }

        if (tail.length) {
            this._activeTimeSegment = {
                kind: lastRecord.kind,
                samples: tail,
            };
        }
    }

    setCurrentView(view) {
        if (!VIEW_LABELS.some(([value]) => value === view))
            return;

        this._currentView = view;
        if (this._settings.get_string('default-view') !== view)
            this._settings.set_string('default-view', view);
        this._indicator?.syncMenuState();
        this._indicator?.queueChartRepaint();
    }

    setCurrentTimeRange(range) {
        if (![...Object.keys(TIME_RANGES), 'custom'].includes(range))
            return;

        this._currentTimeRange = range;
        if (this._settings.get_string('default-time-range') !== range)
            this._settings.set_string('default-time-range', range);
        this._indicator?.syncMenuState();
        this._indicator?.queueChartRepaint();
    }

    drawChart(area) {
        // 查证结果：St.DrawingArea 的 Cairo context 只能在 repaint 处理函数中
        // 获取，并且 GJS 需要在返回前显式调用 cr.$dispose()。
        const cr = area.get_context();
        try {
            this._drawChart(area, cr);
        } finally {
            cr.$dispose();
        }
    }

    _drawChart(area, cr) {
        const [width, height] = area.get_surface_size();
        if (width <= 0 || height <= 0)
            return;

        const theme = this._chartTheme(area);
        this._roundedRect(cr, 0.5, 0.5, width - 1, height - 1, 8);
        cr.setSourceRGBA(theme.bg.r, theme.bg.g, theme.bg.b, theme.bg.a);
        cr.fill();

        const rangeSeconds = this._rangeSeconds(this._currentTimeRange);
        const now = this._nowSeconds();
        const cutoff = now - rangeSeconds;

        if (this._currentView === 'remaining') {
            this._drawRemainingChart(cr, width, height, cutoff, now, rangeSeconds, theme);
            return;
        }

        const series = this._selectSeries(cutoff, now, rangeSeconds);

        if (series.points.length < 2) {
            this._drawCenteredText(cr, width, height, '数据采集中...', theme.fg);
            return;
        }

        const left = 42;
        const right = 14;
        const top = 18;
        const bottom = height - 28;
        const chartWidth = width - left - right;
        const chartHeight = bottom - top;
        const values = series.points.map(point => this._valueForView(point));
        const maxValue = Math.max(...values, 0.1);
        const yMax = maxValue * 1.12;

        this._drawGrid(cr, left, top, chartWidth, chartHeight, theme.grid);
        this._drawAxisLabels(cr, left, top, bottom, yMax, theme.fg);
        this._drawLine(cr, series.points, cutoff, rangeSeconds, left, top,
            chartWidth, chartHeight, yMax, theme.line);
        this._drawTimeLabels(cr, left, bottom, chartWidth, cutoff, now,
            rangeSeconds, theme.fg);
        this._drawCurrentValue(cr, width, top, series.points[series.points.length - 1], theme.line);

        if (series.collecting)
            this._drawCollectingText(cr, left, top, theme.fg);
    }

    _selectSeries(cutoff, now, rangeSeconds) {
        const preferred = this._preferredSource(this._currentTimeRange, rangeSeconds);
        const sourceOrder = {
            raw: ['raw', 'mid', 'coarse'],
            mid: ['mid', 'raw', 'coarse'],
            coarse: ['coarse', 'mid', 'raw'],
        }[preferred];

        let best = {source: preferred, points: []};
        for (const source of sourceOrder) {
            const points = this._dataForSource(source)
                .filter(point => point.t >= cutoff && point.t <= now);
            if (points.length > best.points.length)
                best = {source, points};
            if (source === preferred && points.length >= 2)
                break;
        }

        return {
            points: best.points,
            collecting: best.source !== preferred ||
                best.points.length < 2 ||
                best.points[0].t > cutoff + Math.min(300, rangeSeconds / 10),
        };
    }

    _drawRemainingChart(cr, width, height, cutoff, now, rangeSeconds, theme) {
        const series = this._remainingSeries(cutoff, now);
        const drawablePrediction = this._hasDrawableLine(series.prediction);
        const drawableActual = this._hasDrawableLine(series.actual);

        if (!drawablePrediction && !drawableActual) {
            this._drawCenteredText(cr, width, height, '数据采集中...', theme.fg);
            return;
        }

        const left = 58;
        const right = 14;
        const top = 20;
        const bottom = height - 28;
        const chartWidth = width - left - right;
        const chartHeight = bottom - top;
        const values = [...series.prediction, ...series.actual]
            .map(point => point.value)
            .filter(isFiniteNumber);
        const maxValue = Math.max(...values, 60);
        const yMax = maxValue * 1.12;
        const predictionColor = theme.line;
        const actualColor = {r: 0.93, g: 0.45, b: 0.20, a: 1};

        this._drawGrid(cr, left, top, chartWidth, chartHeight, theme.grid);
        this._drawAxisLabels(cr, left, top, bottom, yMax, theme.fg);
        if (drawablePrediction) {
            this._drawRemainingLine(cr, series.prediction, cutoff, rangeSeconds, left,
                top, chartWidth, chartHeight, yMax, predictionColor, true);
        }
        if (drawableActual) {
            this._drawRemainingLine(cr, series.actual, cutoff, rangeSeconds, left,
                top, chartWidth, chartHeight, yMax, actualColor, false);
        }
        this._drawTimeLabels(cr, left, bottom, chartWidth, cutoff, now,
            rangeSeconds, theme.fg);
        this._drawRemainingLegend(cr, left, top, predictionColor, actualColor,
            theme.fg, drawableActual);

        const latestPrediction = series.prediction[series.prediction.length - 1] ?? null;
        const latestActual = series.actual[series.actual.length - 1] ?? null;
        const latest = latestPrediction ?? latestActual;
        if (latest)
            this._drawRemainingCurrentValue(cr, width, top, latest,
                latestPrediction ? predictionColor : actualColor);
    }

    _remainingSeries(cutoff, now) {
        const prediction = this._rawData
            .filter(record =>
                record.t >= cutoff &&
                record.t <= now &&
                isPredictionKind(record.kind) &&
                isFiniteNumber(record.estimate))
            .map(record => ({
                t: record.t,
                value: record.estimate,
                kind: record.kind,
            }));
        const actual = this._actualTimeData
            .filter(record =>
                record.t >= cutoff &&
                record.t <= now &&
                isPredictionKind(record.kind) &&
                isFiniteNumber(record.actual))
            .map(record => ({
                t: record.t,
                value: record.actual,
                kind: record.kind,
            }));

        return {prediction, actual};
    }

    _hasDrawableLine(points) {
        return this._splitRemainingLine(points).some(group => group.length >= 2);
    }

    _drawRemainingLine(cr, points, cutoff, rangeSeconds, left, top,
        width, height, yMax, color, fill) {
        for (const group of this._splitRemainingLine(points)) {
            if (group.length < 2)
                continue;

            const coords = group.map(point => {
                const x = left + clamp((point.t - cutoff) / rangeSeconds, 0, 1) * width;
                const y = top + height - clamp(point.value / yMax, 0, 1) * height;
                return [x, y];
            });

            if (fill) {
                const gradient = new Cairo.LinearGradient(0, top, 0, top + height);
                gradient.addColorStopRGBA(0, color.r, color.g, color.b, 0.24);
                gradient.addColorStopRGBA(1, color.r, color.g, color.b, 0.02);

                cr.save();
                cr.moveTo(coords[0][0], top + height);
                for (const [x, y] of coords)
                    cr.lineTo(x, y);
                cr.lineTo(coords[coords.length - 1][0], top + height);
                cr.closePath();
                cr.setSource(gradient);
                cr.fill();
                cr.restore();
            }

            cr.save();
            cr.setSourceRGBA(color.r, color.g, color.b, 1);
            cr.setLineWidth(fill ? 2 : 1.8);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            if (!fill)
                cr.setDash([5, 4], 0);
            cr.moveTo(coords[0][0], coords[0][1]);
            for (const [x, y] of coords.slice(1))
                cr.lineTo(x, y);
            cr.stroke();
            cr.restore();
        }
    }

    _splitRemainingLine(points) {
        const groups = [];
        let current = [];
        let previous = null;
        const gapSeconds = this._sampleIntervalSeconds() * TIME_GAP_MULTIPLIER;

        for (const point of points) {
            if (previous &&
                (point.kind !== previous.kind || point.t - previous.t > gapSeconds)) {
                groups.push(current);
                current = [];
            }
            current.push(point);
            previous = point;
        }

        if (current.length)
            groups.push(current);
        return groups;
    }

    _drawRemainingLegend(cr, left, top, predictionColor, actualColor, textColor, showActual) {
        cr.save();
        cr.setFontSize(10);
        cr.setSourceRGBA(predictionColor.r, predictionColor.g, predictionColor.b, 1);
        cr.setLineWidth(2);
        cr.moveTo(left, top - 8);
        cr.lineTo(left + 16, top - 8);
        cr.stroke();
        cr.setSourceRGBA(textColor.r, textColor.g, textColor.b, 0.78);
        cr.moveTo(left + 21, top - 5);
        cr.showText('预测');

        if (showActual) {
            const x = left + 64;
            cr.setSourceRGBA(actualColor.r, actualColor.g, actualColor.b, 1);
            cr.setLineWidth(1.8);
            cr.setDash([5, 4], 0);
            cr.moveTo(x, top - 8);
            cr.lineTo(x + 16, top - 8);
            cr.stroke();
            cr.setDash([], 0);
            cr.setSourceRGBA(textColor.r, textColor.g, textColor.b, 0.78);
            cr.moveTo(x + 21, top - 5);
            cr.showText('实际');
        }
        cr.restore();
    }

    _drawRemainingCurrentValue(cr, width, top, point, color) {
        const text = this._formatChartValue(point.value);

        cr.save();
        cr.setSourceRGBA(color.r, color.g, color.b, 1);
        cr.setFontSize(11);
        const extents = cr.textExtents(text);
        cr.moveTo(Math.max(72, width - extents.width - 12), top);
        cr.showText(text);
        cr.restore();
    }

    _preferredSource(range, rangeSeconds) {
        if (range === 'custom') {
            if (rangeSeconds < 60 * 60)
                return 'raw';
            if (rangeSeconds <= 24 * 60 * 60)
                return 'mid';
            return 'coarse';
        }

        if (['5m', '15m'].includes(range))
            return 'raw';
        if (['1h', '5h'].includes(range))
            return 'mid';
        return 'coarse';
    }

    _dataForSource(source) {
        if (source === 'raw')
            return this._rawData;
        if (source === 'mid')
            return this._midData;
        return this._coarseData;
    }

    _rangeSeconds(range) {
        if (range !== 'custom')
            return TIME_RANGES[range] ?? TIME_RANGES['1h'];

        const value = clamp(this._settings.get_int('custom-range-value'), 1, 365);
        const unit = this._settings.get_string('custom-range-unit');
        if (unit === 'h')
            return value * 60 * 60;
        if (unit === 'd')
            return value * 24 * 60 * 60;
        return value * 60;
    }

    _valueForView(point) {
        return this._currentView === 'power' ? point.p : point.e;
    }

    _drawGrid(cr, left, top, width, height, color) {
        cr.save();
        cr.setSourceRGBA(color.r, color.g, color.b, color.a);
        cr.setLineWidth(1);
        cr.setDash([4, 4], 0);
        for (let i = 0; i <= 3; i++) {
            const y = top + height * i / 3;
            cr.moveTo(left, y);
            cr.lineTo(left + width, y);
        }
        cr.stroke();
        cr.restore();
    }

    _drawAxisLabels(cr, left, top, bottom, yMax, color) {
        cr.save();
        cr.setSourceRGBA(color.r, color.g, color.b, 0.78);
        cr.setFontSize(10);
        cr.moveTo(8, top + 4);
        cr.showText(this._formatAxisValue(yMax));
        cr.moveTo(8, bottom);
        cr.showText('0');
        cr.restore();
    }

    _drawLine(cr, points, cutoff, rangeSeconds, left, top, width, height, yMax, color) {
        const coords = points.map(point => {
            const x = left + clamp((point.t - cutoff) / rangeSeconds, 0, 1) * width;
            const y = top + height - clamp(this._valueForView(point) / yMax, 0, 1) * height;
            return [x, y];
        });

        const gradient = new Cairo.LinearGradient(0, top, 0, top + height);
        gradient.addColorStopRGBA(0, color.r, color.g, color.b, 0.34);
        gradient.addColorStopRGBA(1, color.r, color.g, color.b, 0.03);

        cr.save();
        cr.moveTo(coords[0][0], top + height);
        for (const [x, y] of coords)
            cr.lineTo(x, y);
        cr.lineTo(coords[coords.length - 1][0], top + height);
        cr.closePath();
        cr.setSource(gradient);
        cr.fill();
        cr.restore();

        cr.save();
        cr.setSourceRGBA(color.r, color.g, color.b, 1);
        cr.setLineWidth(2);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.moveTo(coords[0][0], coords[0][1]);
        for (const [x, y] of coords.slice(1))
            cr.lineTo(x, y);
        cr.stroke();
        cr.restore();
    }

    _drawTimeLabels(cr, left, bottom, width, start, end, rangeSeconds, color) {
        const startText = this._formatTimeLabel(start, rangeSeconds);
        const endText = this._formatTimeLabel(end, rangeSeconds);

        cr.save();
        cr.setSourceRGBA(color.r, color.g, color.b, 0.72);
        cr.setFontSize(10);
        const endExtents = cr.textExtents(endText);
        cr.moveTo(left, bottom + 18);
        cr.showText(startText);
        cr.moveTo(left + width - endExtents.width, bottom + 18);
        cr.showText(endText);
        cr.restore();
    }

    _drawCurrentValue(cr, width, top, point, color) {
        const text = this._formatChartValue(this._valueForView(point));

        cr.save();
        cr.setSourceRGBA(color.r, color.g, color.b, 1);
        cr.setFontSize(11);
        const extents = cr.textExtents(text);
        cr.moveTo(Math.max(48, width - extents.width - 12), top);
        cr.showText(text);
        cr.restore();
    }

    _drawCollectingText(cr, left, top, color) {
        cr.save();
        cr.setSourceRGBA(color.r, color.g, color.b, 0.72);
        cr.setFontSize(10);
        cr.moveTo(left, top);
        cr.showText('数据采集中...');
        cr.restore();
    }

    _drawCenteredText(cr, width, height, text, color) {
        cr.save();
        cr.setSourceRGBA(color.r, color.g, color.b, 0.78);
        cr.setFontSize(12);
        const extents = cr.textExtents(text);
        cr.moveTo((width - extents.width) / 2, height / 2);
        cr.showText(text);
        cr.restore();
    }

    _roundedRect(cr, x, y, width, height, radius) {
        const r = Math.min(radius, width / 2, height / 2);
        cr.newSubPath();
        cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
        cr.closePath();
    }

    _chartTheme(area) {
        const node = area.get_theme_node();
        const fg = this._clutterColorToUnit(node.get_foreground_color(), 0.88);
        const bg = this._clutterColorToUnit(node.get_background_color(), 0.16);
        const line = this._parseChartColor(this._settings.get_string('chart-color'));

        return {
            fg,
            line,
            bg: bg.a > 0 ? bg : {r: fg.r, g: fg.g, b: fg.b, a: 0.08},
            grid: {r: fg.r, g: fg.g, b: fg.b, a: 0.18},
        };
    }

    _clutterColorToUnit(color, fallbackAlpha) {
        if (!color)
            return {r: 1, g: 1, b: 1, a: fallbackAlpha};

        return {
            r: color.red / 255,
            g: color.green / 255,
            b: color.blue / 255,
            a: color.alpha > 0 ? color.alpha / 255 : fallbackAlpha,
        };
    }

    _parseChartColor(value) {
        try {
            const [ok, color] = Clutter.Color.from_string(value);
            if (ok)
                return this._clutterColorToUnit(color, 1);
        } catch (error) {
            // Fall through to the manual parser.
        }

        const match = /^#?([0-9a-f]{6})$/i.exec(value ?? '');
        if (!match)
            return {r: 0.21, g: 0.52, b: 0.89, a: 1};

        const number = Number.parseInt(match[1], 16);
        return {
            r: ((number >> 16) & 0xff) / 255,
            g: ((number >> 8) & 0xff) / 255,
            b: (number & 0xff) / 255,
            a: 1,
        };
    }

    _formatAxisValue(value) {
        if (this._currentView === 'remaining')
            return this._formatDurationAxisValue(value);
        if (this._currentView === 'power')
            return value >= 10 ? value.toFixed(0) : value.toFixed(1);
        return value >= 10 ? value.toFixed(0) : value.toFixed(1);
    }

    _formatChartValue(value) {
        if (this._currentView === 'remaining')
            return this._formatDurationWords(value);
        if (this._currentView === 'power')
            return `${value.toFixed(2)} W`;
        return `${value.toFixed(1)} Wh`;
    }

    _formatDurationAxisValue(seconds) {
        if (!isFiniteNumber(seconds))
            return '--';
        if (seconds >= 2 * 60 * 60)
            return `${(seconds / 3600).toFixed(seconds >= 10 * 60 * 60 ? 0 : 1)} 小时`;
        return `${Math.max(1, Math.round(seconds / 60))} 分钟`;
    }

    _formatDurationWords(seconds) {
        if (!isFiniteNumber(seconds))
            return '计算中';

        const minutes = Math.max(0, Math.round(seconds / 60));
        if (minutes < 60)
            return `${minutes} 分钟`;

        const hours = Math.floor(minutes / 60);
        const restMinutes = minutes % 60;
        if (restMinutes === 0)
            return `${hours} 小时`;
        return `${hours} 小时 ${restMinutes} 分`;
    }

    _formatTimeLabel(timestamp, rangeSeconds) {
        const date = new Date(timestamp * 1000);
        const month = `${date.getMonth() + 1}`.padStart(2, '0');
        const day = `${date.getDate()}`.padStart(2, '0');
        const hour = `${date.getHours()}`.padStart(2, '0');
        const minute = `${date.getMinutes()}`.padStart(2, '0');

        if (rangeSeconds >= 24 * 60 * 60)
            return `${month}/${day}`;
        return `${hour}:${minute}`;
    }

    formatPanelPower(powerW, status) {
        if (!isFiniteNumber(powerW))
            return '-- W';
        if (status === 'Full')
            return '0.00 W';
        if (this._isCharging(status))
            return `+${Math.abs(powerW).toFixed(2)} W`;
        return `${Math.abs(powerW).toFixed(2)} W`;
    }

    batteryIconName(status, capacity) {
        if (!Number.isFinite(capacity))
            return 'battery-missing-symbolic';

        const level = clamp(Math.round(capacity / 10) * 10, 0, 100);
        if (status === 'Full')
            return 'battery-level-100-charged-symbolic';
        if (this._isCharging(status)) {
            if (level === 100)
                return 'battery-level-100-plugged-in-symbolic';
            return `battery-level-${level}-charging-symbolic`;
        }
        if (status === 'Not charging')
            return `battery-level-${level}-plugged-in-symbolic`;
        return `battery-level-${level}-symbolic`;
    }

    statusLabel(status) {
        if (status === 'Full')
            return '已充满';
        if (this._isCharging(status))
            return '充电中';
        if (status === 'Discharging')
            return '放电中';
        if (status === 'Not charging')
            return '已接通电源';
        return status || '状态未知';
    }

    _isCharging(status) {
        // GNOME 50 的阈值充电可能出现 PENDING_CHARGE；这里同时兼容
        // 提示词末尾的拼写错误 PENDING_CHAGRE。
        return status === 'Charging' ||
            status === 'PENDING_CHARGE' ||
            status === 'PENDING_CHAGRE';
    }

    _nowSeconds() {
        return Math.floor(Date.now() / 1000);
    }
}
