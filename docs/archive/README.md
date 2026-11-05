# Архив выполненных этапов

Собран 5 ноября 2026 в ветке `codex/docs-current-state-cleanup` от выпуска `77d690e9e560`. Здесь сохранены планы, решения и результаты проверок прежних этапов. Формулировки «локально», «не слито», «не развёрнуто» внутри записей относятся к соответствующему этапу. Они не описывают текущий main: реализация вошла в выпуск `77d690e` и развёрнута на VPS.

Текущее состояние — [PROJECT.md](../PROJECT.md), оставшиеся задачи — [REQUIREMENTS.md](../REQUIREMENTS.md), обслуживание — [VPS.md](../VPS.md). Архивирование истории не закрывает перечисленные там ограничения и ещё не выполненные проверки.

| Этап | Запись |
| --- | --- |
| Подготовка SQLite | [DATA-1.1](plans/DATA-1.1.md) |
| Первая интеграция с Софией | [INTEGRATE](plans/INTEGRATE-sofia.md) |
| Подключаемые GitHub-проекты | [R4](plans/R4-create-task-branch.md) |
| Отдельная страница проектов | [UI projects](plans/UI-projects-page.md) |
| Оформление Софии | [UI style](plans/UI-sofia-style.md) |
| Первые черновики Qwen | [R3 planning](plans/R3-qwen-planning.md) |
| Общая доска на Mac | [План](plans/SHARED-board.md), [прежняя инструкция Tailscale](SHARED-BOARD.md) |
| Первоначальная установка VPS | [OPS](plans/OPS-vps-deployment.md) |
| Многошаговое интервью | [R3 grilling](plans/R3-multistep-grilling.md) |
| Смысловые имена веток | [R4 naming](plans/R4-readable-branch-names.md) |
| Пять колонок и безопасная правка | [R1](plans/R1-five-column-card-edit.md) |
| Review коммита Софии до исправлений | [68b2b5b](reviews/sofia-68b2b5b.md) |

Новые планы создаются в `docs/plans/` по [шаблону](../plans/TEMPLATE.md). Старый пример браузерного клиента `ai-api.example.js` и отдельная устаревшая инструкция `DEPLOYMENT.md` удалены; их история остаётся в Git. Актуальные настройки ИИ описаны в корневом README, развёртывание — в VPS.md.
