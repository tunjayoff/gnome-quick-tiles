// Built-in tiles. Plain data, shared by the extension and the preferences window.
// They start out in the Hidden Tiles tray; the `shown-builtins` setting lists the ones in the menu.

export const BUILTIN_PREFIX = 'builtin:';

export const BUILTIN_TILES = [
    {id: 'keep-awake', title: 'Keep Awake', icon: 'icons/keep-awake-symbolic.svg',
        description: 'Stops the screen from blanking and the computer from suspending'},
    {id: 'screenshot', title: 'Screenshot', icon: 'camera-photo-symbolic',
        description: 'Opens the screenshot tool'},
    {id: 'screen-recording', title: 'Screen Recording', icon: 'media-record-symbolic',
        description: 'Opens the screen recorder'},
    {id: 'microphone', title: 'Microphone', icon: 'audio-input-microphone-symbolic',
        description: 'Mutes or unmutes the default microphone'},
    {id: 'camera-access', title: 'Camera Access', icon: 'camera-web-symbolic',
        description: 'Allows or blocks apps from using the camera'},
    {id: 'location', title: 'Location', icon: 'location-services-active-symbolic',
        description: 'Turns location services on or off'},
    {id: 'touchpad', title: 'Touchpad', icon: 'input-touchpad-symbolic',
        description: 'Turns the touchpad on or off (only shown when there is one)'},
];
