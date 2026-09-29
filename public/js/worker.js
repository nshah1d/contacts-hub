import { ContactEngine } from './core/engine.js';
const workerEngine = new ContactEngine();
// Errors cross the worker boundary as message and code, because structured cloning drops custom Error properties.
self.onmessage = ({ data }) => {
    const { id, type, payload } = data;
    try {
        self.postMessage({ id, result: workerEngine.handle(type, payload) });
    }
    catch (error) {
        self.postMessage({ id, error: { message: error.message, code: error.code || 'ENGINE_ERROR' } });
    }
};
