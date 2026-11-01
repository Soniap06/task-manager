const { AppError } = require("./errors");

// One shared account: bound attempts globally, without trusting client IP headers.
function createWindowLimit(maximum, windowMs, now = Date.now) {
    let start = now();
    let count = 0;
    return () => {
        const current = now();
        if (current - start >= windowMs) {
            start = current;
            count = 0;
        }
        if (count >= maximum) return false;
        count += 1;
        return true;
    };
}

function singleGeneration(generate) {
    let busy = false;
    return async (...args) => {
        if (busy) throw new AppError(429, "ai_busy", "ИИ занят другим запросом. Повторите позже.");
        busy = true;
        try { return await generate(...args); } finally { busy = false; }
    };
}

module.exports = { createWindowLimit, singleGeneration };
