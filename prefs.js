import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';

// 查证结果：GNOME 45+ 的 ExtensionPreferences 位于
// resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js；
// 提示词中的 js/prefs.js 路径不是当前推荐路径。
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const VIEW_OPTIONS = [
    ['power', '功率 (W)'],
    ['energy', '余电'],
    ['remaining', '剩余时间'],
];

const RANGE_OPTIONS = [
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

const UNIT_OPTIONS = [
    ['m', '分钟'],
    ['h', '小时'],
    ['d', '天'],
];

export default class PowerEnergyMonitorPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(500, 560);

        const page = new Adw.PreferencesPage({
            title: _('设置'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const samplingGroup = new Adw.PreferencesGroup({
            title: _('采样与数据保留'),
            description: _('配置数据采集频率和各级历史数据的保留时长'),
        });
        page.add(samplingGroup);

        samplingGroup.add(this._spinRow({
            settings,
            key: 'sample-interval-seconds',
            title: _('采样间隔'),
            subtitle: _('秒，范围 1 到 60'),
            lower: 1,
            upper: 60,
        }));
        samplingGroup.add(this._spinRow({
            settings,
            key: 'raw-retention-hours',
            title: _('原始数据保留'),
            subtitle: _('小时，0 表示永久保留'),
            lower: 0,
            upper: 720,
        }));
        samplingGroup.add(this._spinRow({
            settings,
            key: 'mid-retention-days',
            title: _('中粒度数据保留'),
            subtitle: _('天，0 表示永久保留'),
            lower: 0,
            upper: 3650,
        }));
        samplingGroup.add(this._spinRow({
            settings,
            key: 'coarse-retention-days',
            title: _('粗粒度数据保留'),
            subtitle: _('天，0 表示永久保留'),
            lower: 0,
            upper: 3650,
        }));

        const persistRow = new Adw.SwitchRow({
            title: _('持久化到磁盘'),
            subtitle: _('保存到用户配置目录，跨重启保留历史数据'),
        });
        settings.bind('persist-to-disk', persistRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        samplingGroup.add(persistRow);

        const displayGroup = new Adw.PreferencesGroup({
            title: _('显示'),
            description: _('配置图表默认内容和视觉样式'),
        });
        page.add(displayGroup);

        displayGroup.add(this._comboRow({
            settings,
            key: 'default-view',
            title: _('默认视图'),
            options: VIEW_OPTIONS,
        }));
        displayGroup.add(this._comboRow({
            settings,
            key: 'default-time-range',
            title: _('默认时间范围'),
            options: RANGE_OPTIONS,
        }));

        const colorRow = new Adw.ActionRow({
            title: _('图表颜色'),
            subtitle: _('用于曲线和填充区域'),
        });
        const colorButton = this._colorButton(settings);
        colorButton.valign = Gtk.Align.CENTER;
        colorRow.add_suffix(colorButton);
        colorRow.activatable_widget = colorButton;
        displayGroup.add(colorRow);

        const customGroup = new Adw.PreferencesGroup({
            title: _('自定义时间范围'),
            description: _('当默认时间范围或者菜单选择为自定义时使用'),
        });
        page.add(customGroup);

        customGroup.add(this._spinRow({
            settings,
            key: 'custom-range-value',
            title: _('范围数值'),
            subtitle: _('与下面的单位组合使用'),
            lower: 1,
            upper: 365,
        }));
        customGroup.add(this._comboRow({
            settings,
            key: 'custom-range-unit',
            title: _('范围单位'),
            options: UNIT_OPTIONS,
        }));
    }

    _spinRow({settings, key, title, subtitle, lower, upper}) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            digits: 0,
            numeric: true,
            adjustment: new Gtk.Adjustment({
                lower,
                upper,
                step_increment: 1,
                page_increment: 10,
            }),
        });

        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _comboRow({settings, key, title, options}) {
        const model = new Gtk.StringList();
        for (const [, label] of options)
            model.append(label);

        const current = settings.get_string(key);
        const selected = Math.max(0, options.findIndex(([value]) => value === current));
        const row = new Adw.ComboRow({
            title,
            model,
            selected,
        });

        row.connect('notify::selected', () => {
            const index = row.selected;
            if (index >= 0 && index < options.length)
                settings.set_string(key, options[index][0]);
        });

        return row;
    }

    _colorButton(settings) {
        const rgba = this._rgbaFromSetting(settings.get_string('chart-color'));

        // 查证结果：Gtk.ColorDialogButton 自 GTK 4.10 起可用，并且应当监听
        // notify::rgba；GTK4 的 Gtk.ColorButton 仅作为旧运行环境的兼容路径。
        let button;
        if (Gtk.ColorDialogButton) {
            button = new Gtk.ColorDialogButton({
                dialog: new Gtk.ColorDialog({
                    title: _('选择图表颜色'),
                    with_alpha: false,
                }),
            });
            button.set_rgba(rgba);
        } else {
            button = new Gtk.ColorButton({
                rgba,
                use_alpha: false,
            });
        }

        button.connect('notify::rgba', () => {
            settings.set_string('chart-color', this._rgbaToHex(button.get_rgba()));
        });

        return button;
    }

    _rgbaFromSetting(value) {
        const rgba = new Gdk.RGBA();
        if (!rgba.parse(value))
            rgba.parse('#3584e4');
        return rgba;
    }

    _rgbaToHex(rgba) {
        const toHex = component => {
            const value = Math.round(Math.min(Math.max(component, 0), 1) * 255);
            return value.toString(16).padStart(2, '0');
        };

        return `#${toHex(rgba.red)}${toHex(rgba.green)}${toHex(rgba.blue)}`;
    }
}
