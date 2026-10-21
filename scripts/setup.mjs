import { copyFile } from "node:fs/promises";
import { constants } from "node:fs";

const root = new URL("../", import.meta.url);
try {
    await copyFile(new URL(".env.example", root), new URL(".env", root), constants.COPYFILE_EXCL);
    console.log("Создан .env. Заполните GitHub App и ключ AI_API_KEY, если он нужен.");
} catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.log(".env уже существует; локальные настройки сохранены.");
}
try {
    await copyFile(new URL("ai.config.example.json", root), new URL("ai.config.json", root), constants.COPYFILE_EXCL);
    console.log("Создан ai.config.json. Здесь меняются адрес API, модель и параметры генерации.");
} catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.log("ai.config.json уже существует; настройки ИИ сохранены.");
}
