import GObject from 'gi://GObject';

/**
 * Registers a GObject class under a type name that is still free in this Shell process.
 * Shell derives type names from the file path, so loading a second copy of the extension
 * (e.g. reloading it from Looking Glass) would otherwise fail with "already registered".
 */
export function registerClass(name, klass) {
    let typeName = name;
    for (let n = 2; GObject.type_from_name(typeName); n++)
        typeName = `${name}${n}`;
    return GObject.registerClass({GTypeName: typeName}, klass);
}
