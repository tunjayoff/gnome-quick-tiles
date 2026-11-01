import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickSettingsItem} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {BuiltinTiles} from './builtinTiles.js';
import {CommandTiles} from './commandTiles.js';
import {EditMode} from './editMode.js';
import {registerClass} from './gtype.js';
import {LayoutController} from './layout.js';

const EditButton = registerClass('QuickTilesEditButton',
class EditButton extends QuickSettingsItem {
    _init(onClicked) {
        super._init({
            style_class: 'icon-button',
            can_focus: true,
            icon_name: 'document-edit-symbolic',
            accessible_name: 'Edit Quick Settings',
        });
        this.connect('clicked', onClicked);
    }
});

export default class QuickTilesExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._layout = new LayoutController(this._settings);
        this._editMode = new EditMode(this._layout);
        this._layout.createEditButton = () => new EditButton(() => this._editMode.enter());
        this._layout.enable();
        this._builtinTiles = new BuiltinTiles(this.path);
        this._builtinTiles.enable();
        this._commandTiles = new CommandTiles(this._settings);
        this._commandTiles.enable();
    }

    disable() {
        this._editMode.exit();
        this._editMode = null;
        this._commandTiles.disable();
        this._commandTiles = null;
        this._builtinTiles.disable();
        this._builtinTiles = null;
        this._layout.disable();
        this._layout = null;
        this._settings = null;
    }
}
