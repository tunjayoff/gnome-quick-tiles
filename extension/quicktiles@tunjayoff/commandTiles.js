import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {registerClass} from './gtype.js';

export const CUSTOM_PREFIX = 'custom:';
const STATUS_TIMEOUT_SECONDS = 5;
const FALLBACK_ICON = 'application-x-executable-symbolic';

const CommandTile = registerClass('QuickTilesCommandTile',
class CommandTile extends QuickToggle {
    _init(id, onActivate) {
        super._init({});
        this._quickTilesId = CUSTOM_PREFIX + id;
        this._iconString = null;
        this.connect('clicked', () => onActivate());
    }

    setIcon(icon) {
        icon ||= FALLBACK_ICON;
        if (icon === this._iconString)
            return;
        this._iconString = icon;
        try {
            this.gicon = Gio.Icon.new_for_string(icon);
        } catch {
            this.iconName = FALLBACK_ICON;
        }
    }
});

/**
 * Tiles defined in the `custom-tiles` setting. A button runs `command`; a toggle runs
 * `on`/`off`, and its state comes from `status` (exit code 0 = on, first output line = subtitle).
 */
export class CommandTiles {
    constructor(settings) {
        this._settings = settings;
        this._tiles = new Map();
        this._sources = new Set();
    }

    enable() {
        this._cancellable = new Gio.Cancellable();
        this._settings.connectObject('changed::custom-tiles', () => this._sync(), this);
        this._sync();
    }

    disable() {
        this._settings.disconnectObject(this);
        this._cancellable.cancel();
        this._sources.forEach(id => GLib.source_remove(id));
        this._sources.clear();
        for (const entry of this._tiles.values())
            this._remove(entry);
    }

    _definitions() {
        try {
            const defs = JSON.parse(this._settings.get_string('custom-tiles'));
            return Array.isArray(defs) ? defs.filter(d => typeof d?.id === 'string' && d.id) : [];
        } catch (e) {
            console.warn(`quicktiles: invalid custom-tiles setting: ${e.message}`);
            return [];
        }
    }

    _sync() {
        const seen = new Set();
        for (const def of this._definitions()) {
            seen.add(def.id);
            let entry = this._tiles.get(def.id);
            if (!entry) {
                entry = {active: false, statusText: '', poll: 0, removed: false};
                entry.tile = new CommandTile(def.id, () => this._activate(entry));
                // Added like any other extension's items: Shell puts them before background apps
                entry.indicator = new SystemIndicator();
                entry.indicator.quickSettingsItems.push(entry.tile);
                Main.panel.statusArea.quickSettings.addExternalIndicator(entry.indicator);
                this._tiles.set(def.id, entry);
            }
            entry.def = def;
            entry.tile.title = def.title || def.id;
            entry.tile.setIcon(def.icon);
            this._restartPoll(entry);
            this._render(entry);
            this._refresh(entry);
        }
        for (const entry of [...this._tiles.values()]) {
            if (!seen.has(entry.def.id))
                this._remove(entry);
        }
    }

    _remove(entry) {
        entry.removed = true;
        this._stopPoll(entry);
        entry.tile.destroy();
        entry.indicator.destroy();
        this._tiles.delete(entry.def.id);
    }

    _isToggle(entry) {
        return entry.def.kind === 'toggle';
    }

    _render(entry) {
        entry.tile.checked = this._isToggle(entry) && entry.active;
        entry.tile.subtitle = entry.statusText || entry.def.subtitle || null;
    }

    _stopPoll(entry) {
        if (entry.poll) {
            GLib.source_remove(entry.poll);
            this._sources.delete(entry.poll);
            entry.poll = 0;
        }
    }

    _restartPoll(entry) {
        this._stopPoll(entry);
        const interval = Number(entry.def.interval) || 0;
        if (!this._isToggle(entry) || !entry.def.status || interval <= 0)
            return;
        entry.poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._refresh(entry);
            return GLib.SOURCE_CONTINUE;
        });
        this._sources.add(entry.poll);
    }

    async _refresh(entry) {
        if (!this._isToggle(entry) || !entry.def.status)
            return;
        const result = await this._readStatus(entry.def.status);
        if (!result || entry.removed)
            return;
        entry.active = result.ok;
        entry.statusText = result.text;
        this._render(entry);
    }

    async _activate(entry) {
        const {def} = entry;
        if (!this._isToggle(entry)) {
            if (def.command)
                this._run(def.command);
            return;
        }
        const script = entry.active ? def.off : def.on;
        const ok = !script || await this._run(script);
        if (entry.removed)
            return;
        if (def.status)
            await this._refresh(entry);
        else if (ok)
            entry.active = !entry.active;
        this._render(entry);
    }

    _spawn(script, flags) {
        try {
            return Gio.Subprocess.new(['/bin/sh', '-c', script], flags);
        } catch (e) {
            Main.notifyError('Quick Tiles', `Could not run “${script}”: ${e.message}`);
            return null;
        }
    }

    /** Resolves to whether the command succeeded. Output is discarded so `foo &` can't block it. */
    _run(script) {
        const proc = this._spawn(script,
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        if (!proc)
            return Promise.resolve(false);
        return new Promise(resolve => {
            proc.wait_async(this._cancellable, (p, res) => {
                try {
                    p.wait_finish(res);
                    resolve(p.get_successful());
                } catch {
                    resolve(false);
                }
            });
        });
    }

    _readStatus(script) {
        const proc = this._spawn(script,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        if (!proc)
            return Promise.resolve(null);
        return new Promise(resolve => {
            const timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, STATUS_TIMEOUT_SECONDS, () => {
                this._sources.delete(timeout);
                console.warn(`quicktiles: “${script}” timed out`);
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            this._sources.add(timeout);
            proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
                if (this._sources.delete(timeout))
                    GLib.source_remove(timeout);
                try {
                    const [, stdout] = p.communicate_utf8_finish(res);
                    resolve({ok: p.get_successful(), text: (stdout ?? '').split('\n')[0].trim()});
                } catch {
                    resolve(null);
                }
            });
        });
    }
}
