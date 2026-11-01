import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gvc from 'gi://Gvc';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

import {BUILTIN_PREFIX, BUILTIN_TILES} from './builtinCatalog.js';
import {registerClass} from './gtype.js';

// Screenshot UI modes; Shell does not export the enum
const SCREENSHOT_MODE = 0;
const SCREENCAST_MODE = 1;
// org.gnome.SessionManager.Inhibit flags: suspend | idle
const INHIBIT_SUSPEND_AND_IDLE = 4 | 8;

const BuiltinTile = registerClass('QuickTilesBuiltinTile',
class BuiltinTile extends QuickToggle {
    _init(info, gicon) {
        super._init({title: info.title, gicon});
        this._quickTilesId = BUILTIN_PREFIX + info.id;
    }
});

function lookupSettings(schemaId, key) {
    const schema = Gio.SettingsSchemaSource.get_default().lookup(schemaId, true);
    return schema?.has_key(key) ? new Gio.Settings({settings_schema: schema}) : null;
}

/**
 * A tile that mirrors a setting, with `icons` as [on, off].
 * Hidden when the key does not exist on this system.
 */
function settingToggle(tile, schemaId, key, {isOn, toggle, icons}) {
    const settings = lookupSettings(schemaId, key);
    if (!settings) {
        tile.visible = false;
        return;
    }
    tile._settings = settings;
    const sync = () => {
        const on = isOn(settings, key);
        tile.checked = on;
        tile.iconName = on ? icons[0] : icons[1];
    };
    settings.connectObject(`changed::${key}`, sync, tile);
    tile.connect('clicked', () => toggle(settings, key, tile.checked));
    sync();
}

function boolToggle(tile, schemaId, key, {invert = false, icons}) {
    settingToggle(tile, schemaId, key, {
        isOn: (s, k) => s.get_boolean(k) !== invert,
        toggle: (s, k, on) => s.set_boolean(k, on === invert),
        icons,
    });
}

function openScreenshotUI(mode) {
    Main.panel.closeQuickSettings();
    Main.screenshotUI.open(mode).catch(e =>
        console.warn(`quicktiles: could not open the screenshot tool: ${e.message}`));
}

const SETUPS = {
    'keep-awake'(tile) {
        let cookie = 0;
        let busy = false;
        let destroyed = false;
        const call = (method, params, replyType) => Gio.DBus.session.call(
            'org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager',
            method, params, replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, -1, null);
        const release = () => {
            if (cookie)
                call('Uninhibit', new GLib.Variant('(u)', [cookie])).catch(() => {});
            cookie = 0;
        };

        tile.connect('clicked', async () => {
            if (busy)
                return;
            busy = true;
            try {
                if (cookie) {
                    release();
                } else {
                    const reply = await call('Inhibit',
                        new GLib.Variant('(susu)', ['quicktiles', 0, 'Keep Awake tile', INHIBIT_SUSPEND_AND_IDLE]),
                        '(u)');
                    [cookie] = reply.deepUnpack();
                }
            } catch (e) {
                console.warn(`quicktiles: Keep Awake failed: ${e.message}`);
            }
            busy = false;
            if (destroyed)
                release();
            else
                tile.checked = cookie !== 0;
        });
        return () => {
            destroyed = true;
            release();
        };
    },

    'screenshot'(tile) {
        tile.connect('clicked', () => openScreenshotUI(SCREENSHOT_MODE));
    },

    'screen-recording'(tile) {
        tile.connect('clicked', () => openScreenshotUI(SCREENCAST_MODE));
    },

    'microphone'(tile) {
        const control = Volume.getMixerControl();
        let mic = null;
        const sync = () => {
            const muted = mic?.is_muted ?? true;
            tile.visible = !!mic;
            tile.checked = !muted;
            tile.subtitle = mic && muted ? 'Muted' : null;
            tile.iconName = muted ? 'microphone-disabled-symbolic' : 'audio-input-microphone-symbolic';
        };
        const track = () => {
            mic?.disconnectObject(tile);
            mic = control.get_state() === Gvc.MixerControlState.READY ? control.get_default_source() : null;
            mic?.connectObject('notify::is-muted', sync, tile);
            sync();
        };
        control.connectObject('default-source-changed', track, 'state-changed', track, tile);
        tile.connect('clicked', () => mic?.change_is_muted(!mic.is_muted));
        track();
        return () => mic?.disconnectObject(tile);
    },

    'camera-access'(tile) {
        boolToggle(tile, 'org.gnome.desktop.privacy', 'disable-camera',
            {invert: true, icons: ['camera-web-symbolic', 'camera-disabled-symbolic']});
    },

    'location'(tile) {
        boolToggle(tile, 'org.gnome.system.location', 'enabled',
            {icons: ['location-services-active-symbolic', 'location-services-disabled-symbolic']});
    },

    'touchpad'(tile) {
        settingToggle(tile, 'org.gnome.desktop.peripherals.touchpad', 'send-events', {
            isOn: (s, k) => s.get_string(k) !== 'disabled',
            toggle: (s, k, on) => s.set_string(k, on ? 'disabled' : 'enabled'),
            icons: ['input-touchpad-symbolic', 'touchpad-disabled-symbolic'],
        });
        if (!tile._settings)
            return;
        // Only shown while a touchpad is connected
        const seat = global.stage.context.get_backend().get_default_seat();
        const sync = () => {
            tile.visible = seat.list_devices().some(
                device => device.get_device_type() === Clutter.InputDeviceType.TOUCHPAD_DEVICE);
        };
        seat.connectObject('device-added', sync, 'device-removed', sync, tile);
        sync();
    },
};

/** Adds the built-in tiles. The layout keeps them in the Hidden Tiles tray until the user adds them. */
export class BuiltinTiles {
    constructor(extensionPath) {
        this._path = extensionPath;
        this._entries = [];
    }

    _icon(icon) {
        if (icon.endsWith('.svg'))
            return Gio.FileIcon.new(Gio.File.new_for_path(GLib.build_filenamev([this._path, icon])));
        return Gio.ThemedIcon.new(icon);
    }

    enable() {
        for (const info of BUILTIN_TILES) {
            const tile = new BuiltinTile(info, this._icon(info.icon));
            const cleanup = SETUPS[info.id](tile);
            // Added like any other extension's items: Shell puts them before background apps
            const indicator = new SystemIndicator();
            indicator.quickSettingsItems.push(tile);
            Main.panel.statusArea.quickSettings.addExternalIndicator(indicator);
            this._entries.push({tile, indicator, cleanup: typeof cleanup === 'function' ? cleanup : null});
        }
    }

    disable() {
        for (const {tile, indicator, cleanup} of this._entries) {
            cleanup?.();
            tile.destroy();
            indicator.destroy();
        }
        this._entries = [];
    }
}
