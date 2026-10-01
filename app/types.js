// Shared JSDoc types (DESIGN §10). Typedefs only: this module exports nothing at runtime.

/**
 * Random-access read primitive used everywhere a container is read.
 * `readAt` resolves exactly `len` bytes or rejects with CzdError('truncated') when
 * `off + len > size`. `stream(start = 0, end = size)` yields the bytes in [start, end)
 * (end exclusive) in chunks of any size. `blob` exists for memory/OPFS/IDB sources.
 * @typedef {{size:number, readAt(off:number,len:number):Promise<Uint8Array>, stream(start?:number, end?:number):AsyncIterable<Uint8Array>, blob?:Blob}} ByteSource
 */

/** @typedef {{type:number, body:Uint8Array}} Stanza */

/** @typedef {{kek:CryptoKey, salt:Uint8Array, params:{m:number,t:number,p:number}}} PassKek */

/**
 * @typedef {{headerLen:number, chunkExp:number, chunkSize:number, n:number, streamSalt:Uint8Array, stanzas:Stanza[], meta:object, size:number, paddedSize:number, mac:Uint8Array, via:'pass'|'vault', kdf?:{m:number,t:number,p:number}, keys:{mac:CryptoKey,meta:CryptoKey,pay:CryptoKey}, fileKey:Uint8Array|null, isBundle:boolean}} Opened
 */

/** @typedef {'image'|'video'|'audio'|'doc'|'note'|'other'} Kind */

/**
 * @typedef {{id:string, name:string, type:string, kind:Kind, size:number, mtime?:number, addedAt:number, storedBytes:number, fav:boolean, hasThumb:boolean, duration?:number}} ItemInfo
 */

/** @typedef {{id:string, name:string, itemIds:string[], cover?:string, createdAt:number}} ListInfo */

/**
 * @typedef {{kind:'container', src:ByteSource, opened:Opened, entry?:{off:number,size:number,name:string,type:string}} | {kind:'plain', blob:Blob, name:string, type:string}} DecryptSource
 */

/**
 * @typedef {{key:string, name:string, type:string, kind:Kind, size:number, getSource:()=>Promise<DecryptSource>, actions?:Array<'save'|'share'|'send'|'addToVault'|'rename'|'delete'|'fav'|'editNote'|'album'>}} ViewerItem
 */

/** @typedef {{top:string, parts:string[], query:URLSearchParams, hash:string}} Route */

/**
 * @typedef {{mount(root:HTMLElement, route:Route, ctx:{vault:any, state:any}):{update?(route:Route):void, unmount():void}}} ViewModule
 */

/**
 * @typedef {{kind:'tauri-file'|'tauri-dir'|'fs-handle'|'fs-dir'|'stage', count:number, write(name:string, source:AsyncIterable<Uint8Array>|Blob, opts:{size?:number, mime?:string, signal?:AbortSignal}):Promise<{name:string, where?:string, staged?:File}>, abort():Promise<void>}} SaveTarget
 */

/**
 * Container store backends (vault/store.js): MemoryStore, OpfsStore, IdbBlobStore, TauriFsStore.
 * Every method is async. `write` resolves with the byte count written; on error/abort nothing
 * is left behind. `source(id)` rejects with CzdError('item-file-missing') for unknown ids.
 * `delete(id)` is idempotent. `list()` resolves item files as {id, size, mtime}.
 * `stage(name, source)` writes a temporary output (Send) and resolves a File.
 * `sweep({knownIds})` deletes tmp files older than 24 h and item files with no record older than 1 h,
 * resolving the counts. `estimate()` resolves {usage, quota, persisted} (fields may be null) or null.
 * @typedef {{
 *   kind: string,
 *   init(): Promise<void>,
 *   write(id:string, source:AsyncIterable<Uint8Array>|Iterable<Uint8Array>|Blob|Uint8Array, opts?:{signal?:AbortSignal}): Promise<number>,
 *   source(id:string): Promise<ByteSource>,
 *   delete(id:string): Promise<void>,
 *   list(): Promise<Array<{id:string, size:number, mtime:number}>>,
 *   stage(name:string, source:AsyncIterable<Uint8Array>|Iterable<Uint8Array>|Blob|Uint8Array, opts?:{signal?:AbortSignal}): Promise<File>,
 *   sweep(opts:{knownIds:Iterable<string>}): Promise<{tmp:number, orphans:number}>,
 *   estimate(): Promise<{usage:number|null, quota:number|null, persisted:boolean|null}|null>
 * }} ContainerStore
 */

/**
 * IndexedDB wrapper (vault/db.js).
 * @typedef {{
 *   getMeta(): Promise<object|undefined>,
 *   putMeta(rec:object, opts?:{expectWrapCt?:Uint8Array}): Promise<void>,
 *   getAll(store:string): Promise<object[]>,
 *   get(store:string, id:string): Promise<object|undefined>,
 *   put(store:string, rec:object): Promise<void>,
 *   delete(store:string, id:string): Promise<void>,
 *   commit(ops:Array<{op:'put'|'delete', store:string, value?:object, key?:any}>): Promise<void>,
 *   kvGet(k:string): Promise<any>,
 *   kvSet(k:string, v:any): Promise<void>,
 *   clearAll(): Promise<void>,
 *   close(): void,
 *   exportSnapshot(): Promise<object>,
 *   importSnapshot(snap:object): Promise<void>
 * }} VaultDb
 */

export {};
