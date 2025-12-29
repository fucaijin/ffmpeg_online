/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { CORE_URL, FFMessageType } from "./const.js";
import { ERROR_UNKNOWN_MESSAGE_TYPE, ERROR_NOT_LOADED, ERROR_IMPORT_FAILURE, } from "./errors.js";
let ffmpeg;
const load = async ({ coreURL: _coreURL, wasmURL: _wasmURL, workerURL: _workerURL, }) => {
    const first = !ffmpeg;
    try {
        if (!_coreURL)
            _coreURL = CORE_URL;
        
        // Ensure we're not trying to load from local file system
        if (_coreURL.startsWith('file:')) {
            _coreURL = CORE_URL; // Fallback to CDN URL
        }
        
        // Check if we're in a module worker by trying to call importScripts
        let isModuleWorker = false;
        try {
            if (typeof importScripts !== 'undefined') {
                // Try to call importScripts with a dummy URL
                importScripts('data:,');
            } else {
                isModuleWorker = true;
            }
        } catch (e) {
            // If importScripts throws, we're in a module worker
            isModuleWorker = true;
        }
        
        console.log('Worker type:', isModuleWorker ? 'module' : 'classic');
        
        if (isModuleWorker) {
            // MODULE WORKER PATH - ABSOLUTELY NO IMPORTSCRIPTS
            console.log('Loading as module worker, using dynamic import');
            
            try {
                // Respect the provided coreURL, whether it's local or remote
                let finalUrl = _coreURL;
                
                // Only switch to CDN if the URL is a blob URL or file URL
                if (_coreURL.startsWith('blob:') || _coreURL.startsWith('file:')) {
                    finalUrl = CORE_URL.replace('/umd/', '/esm/');
                    console.log('Switching from blob/file to CDN URL:', finalUrl);
                }
                
                // Try to import the module
                console.log('Attempting to load from URL:', finalUrl);
                const module = await import(/* @vite-ignore */ finalUrl);
                
                // Try different export patterns
                if (module.default && typeof module.default === 'function') {
                    self.createFFmpegCore = module.default;
                    console.log('Loaded createFFmpegCore from module.default');
                } else if (module.createFFmpegCore && typeof module.createFFmpegCore === 'function') {
                    self.createFFmpegCore = module.createFFmpegCore;
                    console.log('Loaded createFFmpegCore from module.createFFmpegCore');
                } else {
                    throw new Error('No valid createFFmpegCore export found');
                }
            } catch (e) {
                console.error('Dynamic import failed:', e.message);
                throw new Error(`Failed to load ffmpeg-core in module worker: ${e.message}`);
            }
        } else {
            // CLASSIC WORKER PATH - CAN USE IMPORTSCRIPTS
            console.log('Loading as classic worker, using importScripts');
            
            if (_coreURL.startsWith('blob:')) {
                // For blob URLs in classic workers
                const response = await fetch(_coreURL);
                const scriptText = await response.text();
                
                // Create a new blob URL and use importScripts
                const blob = new Blob([scriptText], { type: 'text/javascript' });
                const blobUrl = URL.createObjectURL(blob);
                
                try {
                    importScripts(blobUrl);
                } finally {
                    URL.revokeObjectURL(blobUrl);
                }
            } else {
                // For regular URLs in classic workers
                importScripts(_coreURL);
            }
            
            // Ensure createFFmpegCore is available on self
            if (typeof self.createFFmpegCore !== 'function') {
                throw new Error('createFFmpegCore not found after importScripts');
            }
        }
        
        // Final check to ensure createFFmpegCore is available
        if (typeof self.createFFmpegCore !== 'function') {
            throw new Error('createFFmpegCore is not a function after loading');
        }
    }
    catch (error) {
        console.error('Error loading ffmpeg-core:', error);
        
        // Ultimate fallback: load from CDN using dynamic import for module workers
        _coreURL = CORE_URL.replace('/umd/', '/esm/');
        
        try {
            // Use dynamic import for all cases as fallback
            // This works for both module and classic workers in modern browsers
            const module = await import(/* @vite-ignore */ _coreURL);
            
            // Try different export patterns
            if (module.default && typeof module.default === 'function') {
                self.createFFmpegCore = module.default;
            } else if (module.createFFmpegCore && typeof module.createFFmpegCore === 'function') {
                self.createFFmpegCore = module.createFFmpegCore;
            } else {
                // Last resort for classic workers
                if (typeof importScripts !== 'undefined') {
                    importScripts(_coreURL);
                }
            }
        } catch (fallbackError) {
            console.error('Fallback loading failed:', fallbackError);
        }
        
        // Final check
        if (typeof self.createFFmpegCore !== 'function') {
            throw ERROR_IMPORT_FAILURE;
        }
    }
    const coreURL = _coreURL;
    let wasmURL = _wasmURL ? _wasmURL : _coreURL.replace(/.js$/g, ".wasm");
    let workerURL = _workerURL
        ? _workerURL
        : _coreURL.replace(/.js$/g, ".worker.js");
    
    // Log the URLs for debugging
    console.log('Core URL:', coreURL);
    console.log('WASM URL:', wasmURL);
    console.log('Worker URL:', workerURL);
    
    // Only switch to CDN URLs if the URLs are file URLs or blob URLs that don't have corresponding files
    // For HTTP URLs (like our local server), keep using them
    if (wasmURL.startsWith('file:')) {
        wasmURL = CORE_URL.replace(/.js$/g, ".wasm");
        console.log('Switched WASM URL to CDN:', wasmURL);
    }
    
    if (workerURL.startsWith('file:')) {
        workerURL = CORE_URL.replace(/.js$/g, ".worker.js");
        console.log('Switched Worker URL to CDN:', workerURL);
    }
    
    // If coreURL is a blob URL, ensure wasmURL and workerURL are also blob URLs or valid HTTP URLs
    if (coreURL.startsWith('blob:')) {
        if (!_wasmURL) {
            wasmURL = CORE_URL.replace(/.js$/g, ".wasm");
            console.log('Core is blob, using CDN for WASM:', wasmURL);
        }
        if (!_workerURL) {
            workerURL = CORE_URL.replace(/.js$/g, ".worker.js");
            console.log('Core is blob, using CDN for Worker:', workerURL);
        }
    }
    ffmpeg = await self.createFFmpegCore({
        // Fix `Overload resolution failed.` when using multi-threaded ffmpeg-core.
        // Encoded wasmURL and workerURL in the URL as a hack to fix locateFile issue.
        mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL, workerURL }))}`,
    });
    ffmpeg.setLogger((data) => self.postMessage({ type: FFMessageType.LOG, data }));
    ffmpeg.setProgress((data) => self.postMessage({
        type: FFMessageType.PROGRESS,
        data,
    }));
    return first;
};
const exec = ({ args, timeout = -1 }) => {
    ffmpeg.setTimeout(timeout);
    ffmpeg.exec(...args);
    const ret = ffmpeg.ret;
    ffmpeg.reset();
    return ret;
};
const ffprobe = ({ args, timeout = -1 }) => {
    ffmpeg.setTimeout(timeout);
    ffmpeg.ffprobe(...args);
    const ret = ffmpeg.ret;
    ffmpeg.reset();
    return ret;
};
const writeFile = ({ path, data }) => {
    ffmpeg.FS.writeFile(path, data);
    return true;
};
const readFile = ({ path, encoding }) => ffmpeg.FS.readFile(path, { encoding });
// TODO: check if deletion works.
const deleteFile = ({ path }) => {
    ffmpeg.FS.unlink(path);
    return true;
};
const rename = ({ oldPath, newPath }) => {
    ffmpeg.FS.rename(oldPath, newPath);
    return true;
};
// TODO: check if creation works.
const createDir = ({ path }) => {
    ffmpeg.FS.mkdir(path);
    return true;
};
const listDir = ({ path }) => {
    const names = ffmpeg.FS.readdir(path);
    const nodes = [];
    for (const name of names) {
        const stat = ffmpeg.FS.stat(`${path}/${name}`);
        const isDir = ffmpeg.FS.isDir(stat.mode);
        nodes.push({ name, isDir });
    }
    return nodes;
};
// TODO: check if deletion works.
const deleteDir = ({ path }) => {
    ffmpeg.FS.rmdir(path);
    return true;
};
const mount = ({ fsType, options, mountPoint }) => {
    const str = fsType;
    const fs = ffmpeg.FS.filesystems[str];
    if (!fs)
        return false;
    ffmpeg.FS.mount(fs, options, mountPoint);
    return true;
};
const unmount = ({ mountPoint }) => {
    ffmpeg.FS.unmount(mountPoint);
    return true;
};
self.onmessage = async ({ data: { id, type, data: _data }, }) => {
    const trans = [];
    let data;
    try {
        if (type !== FFMessageType.LOAD && !ffmpeg)
            throw ERROR_NOT_LOADED; // eslint-disable-line
        switch (type) {
            case FFMessageType.LOAD:
                data = await load(_data);
                break;
            case FFMessageType.EXEC:
                data = exec(_data);
                break;
            case FFMessageType.FFPROBE:
                data = ffprobe(_data);
                break;
            case FFMessageType.WRITE_FILE:
                data = writeFile(_data);
                break;
            case FFMessageType.READ_FILE:
                data = readFile(_data);
                break;
            case FFMessageType.DELETE_FILE:
                data = deleteFile(_data);
                break;
            case FFMessageType.RENAME:
                data = rename(_data);
                break;
            case FFMessageType.CREATE_DIR:
                data = createDir(_data);
                break;
            case FFMessageType.LIST_DIR:
                data = listDir(_data);
                break;
            case FFMessageType.DELETE_DIR:
                data = deleteDir(_data);
                break;
            case FFMessageType.MOUNT:
                data = mount(_data);
                break;
            case FFMessageType.UNMOUNT:
                data = unmount(_data);
                break;
            default:
                throw ERROR_UNKNOWN_MESSAGE_TYPE;
        }
    }
    catch (e) {
        self.postMessage({
            id,
            type: FFMessageType.ERROR,
            data: e.toString(),
        });
        return;
    }
    if (data instanceof Uint8Array) {
        trans.push(data.buffer);
    }
    self.postMessage({ id, type, data }, trans);
};
