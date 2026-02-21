# Интеграция с Neon Database - Готово! ✅

## Что подключено

### Базы данных
- **База**: `D1_roleplay` в проекте Neon "SM"
- **Таблицы D1 (Госники - B2G)**: 20 звонков
  - `d1_users`
  - `d1_calls`
  - `d1_avatars`

- **Таблицы R1 (Коммерсы - B2B)**: 13 звонков
  - `r1_users`
  - `r1_calls`
  - `r1_avatars`

### Файлы проекта

#### 1. Схема БД
- `/src/lib/db/schema-existing.ts` - Drizzle схемы для существующих таблиц

#### 2. Подключение
- `/src/lib/db/index.ts` - Подключение к Neon через Drizzle ORM
- `/.env.local` - Строка подключения к D1_roleplay

#### 3. Запросы к БД
- `/src/lib/db/queries-existing.ts` - Функции для получения данных:
  - `getAIRoleCalls(department)` - Получить все звонки для отдела
  - `getManagerStats(department)` - Получить статистику менеджеров

#### 4. API Endpoints
- `/src/app/api/calls/route.ts` - REST API для получения данных

## API Использование

### Получить звонки
```bash
GET /api/calls?department=b2g&type=calls  # Госники
GET /api/calls?department=b2b&type=calls  # Коммерсы
```

### Получить статистику менеджеров
```bash
GET /api/calls?department=b2g&type=managers  # Госники
GET /api/calls?department=b2b&type=managers  # Коммерсы
```

## Следующие шаги

### Для использования в UI - обновить `/src/app/page.tsx`:

```typescript
// Добавить в компонент Dashboard
const [calls, setCalls] = useState([]);
const [managers, setManagers] = useState([]);
const [loading, setLoading] = useState(true);

useEffect(() => {
  setLoading(true);

  Promise.all([
    fetch(`/api/calls?department=${activeDepartment === "b2g" ? "b2g" : "b2b"}&type=calls`).then(r => r.json()),
    fetch(`/api/calls?department=${activeDepartment === "b2g" ? "b2g" : "b2b"}&type=managers`).then(r => r.json())
  ]).then(([callsRes, managersRes]) => {
    setCalls(callsRes.data);
    setManagers(managersRes.data);
    setLoading(false);
  });
}, [activeDepartment]);

// Использовать calls вместо mockCalls и managers вместо mockManagers
```

## Проверка работы

```bash
# Запустить dev сервер
npm run dev

# Проверить API (в другом терминале)
curl "http://localhost:3000/api/calls?department=b2g&type=calls"
curl "http://localhost:3000/api/calls?department=b2b&type=calls"
```

## Переменные окружения

Файл `.env.local` уже настроен:
```env
DATABASE_URL=postgresql://neondb_owner:...@ep-withered-recipe-ai1ea97w-pooler.c-4.us-east-1.aws.neon.tech/D1_roleplay?sslmode=require
```
