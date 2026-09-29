/**
 * Runs the contact engine in a module worker, so parsing and search never block the
 * interface. One worker serves one workspace. A request that exceeds the timeout, or a
 * worker that fails, restarts the worker and rejects every waiting request; saved files
 * are unaffected because the worker holds only parsed copies.
 */
export class EngineClient {
    constructor(factory = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }), timeoutMs = 120000) {
        this.factory = factory;
        this.timeoutMs = timeoutMs;
        this.sequence = 0;
        this.pending = new Map();
        this.closed = false;
        this.start();
    }
    start() {
        if (this.closed)
            return;
        const worker = this.factory();
        this.worker = worker;
        worker.onmessage = ({ data }) => {
            const waiter = this.pending.get(data.id);
            if (!waiter)
                return;
            this.pending.delete(data.id);
            clearTimeout(waiter.timer);
            if (data.error) {
                const e = new Error(data.error.message);
                e.code = data.error.code;
                waiter.reject(e);
            }
            else
                waiter.resolve(data.result);
        };
        worker.onerror = () => {
            if (this.worker === worker)
                this.restart(new Error('The contact worker stopped. Reopen the source; saved files are unchanged.'));
        };
    }
    failAll(error) {
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(error);
        }
        this.pending.clear();
    }
    request(type, payload = {}) {
        if (this.closed)
            return Promise.reject(new Error('Workspace closed.'));
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.restart(new Error('Processing timed out. Reconnect or reopen the workspace.'));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.worker.postMessage({ id, type, payload });
            }
            catch (error) {
                this.restart(error);
            }
        });
    }
    restart(error) {
        const worker = this.worker;
        this.worker = null;
        worker?.terminate();
        this.failAll(error);
        this.start();
    }
    reset() {
        this.worker?.terminate();
        this.failAll(new Error('Workspace closed.'));
        this.start();
    }
    destroy() {
        this.closed = true;
        this.worker?.terminate();
        this.worker = null;
        this.failAll(new Error('Workspace closed.'));
    }
}
