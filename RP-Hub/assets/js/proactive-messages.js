// Isolated metadata only: never stores or mutates conversation/card/memory data.
(function () {
    const KEY = 'rp_hub_proactive_v1';
    const defaults = { enabled: false, intervalHours: 2, dailyLimit: 3 };
    const normalize = (value = {}) => ({
        enabled: value.enabled === true,
        intervalHours: Math.max(2, Math.min(168, Number(value.intervalHours) || 2)),
        dailyLimit: Math.max(1, Math.min(3, Math.floor(Number(value.dailyLimit) || 3)))
    });
    // Explicit Beijing calendar day; no Date/fetch monkey patches, compatible with time userscripts.
    const dayKey = now => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
    const eligible = (state, id, config, now) => {
        const entry = state.characters?.[id];
        const interval = config.intervalHours * 3600000;
        return config.enabled && Number.isFinite(entry?.lastInteraction)
            && now - entry.lastInteraction >= interval
            && (!entry.lastAttempt || now - entry.lastAttempt >= interval)
            && (state.daily?.[dayKey(now)] || 0) < config.dailyLimit;
    };
    // A single read/write transaction serializes clicks across tabs (including Safari).
    const transact = (db, mutate) => new Promise((resolve, reject) => {
        const tx = db.transaction('store', 'readwrite');
        const store = tx.objectStore('store');
        const request = store.get(KEY);
        let result;
        request.onsuccess = () => {
            const state = request.result || { characters: {}, daily: {} };
            state.characters ||= {};
            state.daily ||= {};
            result = mutate(state);
            if (result.write) store.put(state, KEY);
        };
        tx.oncomplete = () => resolve(result.value);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('主动消息记录保存失败'));
    });
    const read = db => transact(db, state => ({ value: state }));
    const touch = (db, id, now) => transact(db, state => {
        state.characters[id] = { ...state.characters[id], lastInteraction: now };
        return { write: true };
    });
    const claim = (db, id, config, now, expectedInteraction) => transact(db, state => {
        if (!eligible(state, id, config, now)
            || state.characters[id].lastInteraction !== expectedInteraction) return { value: false };
        state.characters[id].lastAttempt = now;
        state.daily[dayKey(now)] = (state.daily[dayKey(now)] || 0) + 1;
        // Keep a bounded counter history; failed/aborted requests consume their attempt.
        Object.keys(state.daily).filter(day => day < dayKey(now - 7 * 86400000)).forEach(day => delete state.daily[day]);
        return { write: true, value: true };
    });
    const prompt = (lastInteraction, now) => `[角色主动消息｜仅本次请求的系统指令]
用户没有发送新消息，不要再次回答或复述上一条用户发言。请以当前角色身份，根据最近主线剧情、角色性格、未解决的事情和已有记忆，自然地主动发来一条消息，给用户留下回应空间。不要套用固定问候，不要替用户编造言行，也不要把现实流逝强行等同于剧情时间。
距最后互动约 ${Math.floor((now - lastInteraction) / 60000)} 分钟。当前北京时间：${new Date(now + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19)}。已有时间注入及剧情设定仍然有效。只生成这一条主动消息。`;
    window.RPHubProactive = Object.freeze({ defaults, normalize, dayKey, eligible, read, touch, claim, prompt });
})();
