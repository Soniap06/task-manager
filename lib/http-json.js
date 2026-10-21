const { AppError } = require("./errors");

async function readRaw(stream, maxBytes = 1_000_000) {
    let size = 0;
    const chunks = [];
    const iterator = stream.iterator ? stream.iterator({ destroyOnReturn: false }) : stream;
    for await (const chunk of iterator) {
        size += chunk.length;
        if (size > maxBytes) {
            if (stream.resume) stream.resume();
            throw new AppError(413, "body_too_large", "Превышен допустимый размер JSON.");
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function readJson(stream, maxBytes = 1_000_000) {
    const raw = await readRaw(stream, maxBytes);
    try {
        return JSON.parse(raw.toString("utf8"));
    } catch {
        throw new AppError(400, "invalid_json", "Ожидался корректный JSON.");
    }
}

module.exports = { readJson, readRaw };
