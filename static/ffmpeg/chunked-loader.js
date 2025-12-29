// chunked-loader.js - 用于分块加载和缓存ffmpeg-core.wasm文件
// 这个脚本应该在ffmpeg-core.js之前加载

// 定义FFmpegLoader类
class FFmpegLoader {
    constructor() {
        this.dbName = 'FFmpegCache';
        this.storeName = 'ffmpegFiles';
        this.chunkStoreName = 'ffmpegChunks';
        this.db = null;
    }

    // 初始化IndexedDB
    async initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);

            request.onerror = (event) => {
                console.error('Failed to open IndexedDB:', event.target.error);
                reject(event.target.error);
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // 创建完整文件存储
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: 'name' });
                }
                
                // 创建块文件存储
                if (!db.objectStoreNames.contains(this.chunkStoreName)) {
                    db.createObjectStore(this.chunkStoreName, { keyPath: 'name' });
                }
            };
        });
    }

    // 保存blob到IndexedDB
    async saveToDB(storeName, name, blob) {
        if (!this.db) {
            await this.initDB();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.put({ name, blob, timestamp: Date.now() });

            request.onsuccess = () => resolve();
            request.onerror = (event) => {
                console.error('Failed to save to DB:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    // 从IndexedDB获取blob
    async getFromDB(storeName, name) {
        if (!this.db) {
            await this.initDB();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.get(name);

            request.onsuccess = () => resolve(request.result ? request.result.blob : null);
            request.onerror = (event) => {
                console.error('Failed to get from DB:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    // 从IndexedDB删除
    async deleteFromDB(storeName, name) {
        if (!this.db) {
            await this.initDB();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.delete(name);

            request.onsuccess = () => resolve();
            request.onerror = (event) => {
                console.error('Failed to delete from DB:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    // 从IndexedDB删除多个
    async deleteMultipleFromDB(storeName, names) {
        if (!this.db) {
            await this.initDB();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            
            names.forEach(name => {
                store.delete(name);
            });

            transaction.oncomplete = () => resolve();
            transaction.onerror = (event) => {
                console.error('Failed to delete multiple from DB:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    // 获取单个块
    async fetchChunk(chunkUrl, chunkName) {
        // 检查块是否已存在于缓存中
        const cachedChunk = await this.getFromDB(this.chunkStoreName, chunkName);
        if (cachedChunk) {
            console.log(`Using cached chunk: ${chunkName}`);
            return cachedChunk;
        }

        // 获取块
        console.log(`Fetching chunk: ${chunkName}`);
        const response = await fetch(chunkUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch chunk ${chunkName}: ${response.statusText}`);
        }

        const blob = await response.blob();
        
        // 保存到缓存
        await this.saveToDB(this.chunkStoreName, chunkName, blob);
        return blob;
    }

    // 获取所有块并重新组装
    async fetchAndAssembleChunks(baseUrl, manifest) {
        // 获取所有块
        const chunkPromises = manifest.chunks.map((chunkName, index) => {
            const chunkUrl = `${baseUrl}/chunks/${chunkName}`;
            return this.fetchChunk(chunkUrl, chunkName);
        });

        // 等待所有块获取完成
        const chunks = await Promise.all(chunkPromises);
        
        // 将块组装成单个blob
        const totalSize = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
        const assembledBlob = new Blob(chunks, { type: 'application/wasm' });
        
        console.log(`Assembled ${chunks.length} chunks into blob of size ${totalSize} bytes`);
        
        // 将组装好的blob保存到缓存
        await this.saveToDB(this.storeName, manifest.filename, assembledBlob);
        
        // 删除临时块
        await this.deleteMultipleFromDB(this.chunkStoreName, manifest.chunks);
        
        return assembledBlob;
    }

    // 加载manifest
    async loadManifest(baseUrl) {
        const manifestUrl = `${baseUrl}/chunks/manifest.json`;
        const response = await fetch(manifestUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch manifest: ${response.statusText}`);
        }
        return await response.json();
    }

    // 使用分块加载和缓存加载ffmpeg-core.wasm
    async loadWasmFile(baseUrl) {
        // 检查完整文件是否已存在于缓存中
        const cachedFile = await this.getFromDB(this.storeName, 'ffmpeg-core.wasm');
        if (cachedFile) {
            console.log('Using cached full wasm file');
            return cachedFile;
        }

        // 加载manifest
        const manifest = await this.loadManifest(baseUrl);
        
        // 获取并组装块
        return await this.fetchAndAssembleChunks(baseUrl, manifest);
    }

    // 初始化ffmpeg加载器
    async init() {
        await this.initDB();
    }

    // 从缓存中获取wasm文件
    async getCachedWasmFile() {
        return await this.getFromDB(this.storeName, 'ffmpeg-core.wasm');
    }

    // 将wasm文件转换为array buffer
    async getWasmArrayBuffer() {
        const wasmBlob = await this.getCachedWasmFile();
        if (!wasmBlob) {
            throw new Error('Wasm file not found in cache');
        }
        return await wasmBlob.arrayBuffer();
    }
}

// 创建FFmpegLoader实例
const ffmpegLoader = new FFmpegLoader();

// 开始加载wasm文件
(async () => {
    try {
        // 初始化加载器
        await ffmpegLoader.init();
        
        // 获取base URL
        const baseUrl = './static/ffmpeg';
        
        // 使用分块加载和缓存加载wasm文件
        await ffmpegLoader.loadWasmFile(baseUrl);
        
        console.log('Wasm file loaded and cached successfully');
        
        // 触发自定义事件，通知其他脚本wasm文件已加载完成
        const event = new CustomEvent('wasmLoaded');
        window.dispatchEvent(event);
    } catch (error) {
        console.error('Failed to load wasm file:', error);
    }
})();

// 将FFmpegLoader实例暴露到全局作用域
window.ffmpegLoader = ffmpegLoader;