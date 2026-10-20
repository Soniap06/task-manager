import { copyFile } from "node:fs/promises";
import { constants } from "node:fs";

const root = new URL("../", import.meta.url);
try {
    await copyFile(new URL(".env.example", root), new URL(".env", root), constants.COPYFILE_EXCL);
    console.log("Создан .env. Заполните GitHub App и параметры модели LM Studio.");
} catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.log(".env уже существует; локальные настройки сохранены.");
}
