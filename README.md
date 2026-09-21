# yaniv

שרת המשחק **יניב** – Express + Socket.IO. מגיש גם את הקליינט הבנוי מתוך `dist/`.

## הרצה

```bash
npm install
npm start        # מאזין על process.env.PORT (ברירת מחדל 3210)
```

`npm test` מריץ את בדיקות מנוע המשחק.

## פריסה ב-Render

Web Service מהריפו הזה:

- **Build command:** `npm install`
- **Start command:** `npm start`

הפורט נלקח אוטומטית מ-`PORT`. הקליינט ב-`dist/` נבנה בפרויקט הקליינט (`npm run deploy`) ומועתק לכאן – אין צורך בשלב build נוסף ב-Render.

## מבנה

- `src/index.js` – HTTP + Socket.IO, הגשת `dist/`
- `src/rooms.js` – חדרים, מארח, חיבור מחדש
- `src/game/engine.js` – מנוע המשחק
- `shared/` – חוקי המשחק (משותפים עם הקליינט)
- `test/` – בדיקות (`node --test`)
