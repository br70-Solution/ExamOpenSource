const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'prof2026';
const EXAM_TITLE = process.env.EXAM_TITLE || 'Logiciel Libre - Open Source';
const DURATION_MINUTES = Number(process.env.DURATION_MINUTES) || 60;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== DATABASE =====
const DB_PATH = path.join(__dirname, 'databases', 'exam.db');
if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

function getDB() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_token TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      group_number TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT,
      score INTEGER DEFAULT 0,
      total_questions INTEGER DEFAULT 0,
      submitted INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      question_index INTEGER NOT NULL,
      selected_answer INTEGER NOT NULL,
      is_correct INTEGER DEFAULT 0,
      FOREIGN KEY (student_id) REFERENCES students(id),
      UNIQUE(student_id, question_index)
    );
    CREATE INDEX IF NOT EXISTS idx_session ON students(session_token);
    CREATE INDEX IF NOT EXISTS idx_name_group ON students(full_name, group_number);
  `);
  return db;
}

function loadQuestions() {
  const p = path.join(__dirname, 'data', 'questions.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ===== API =====

app.get('/api/config', (_, res) => {
  const q = loadQuestions();
  res.json({ title: EXAM_TITLE, totalQuestions: q.length, duration: DURATION_MINUTES });
});

app.post('/api/login', (req, res) => {
  const { fullName, groupNumber } = req.body;
  if (!fullName || !groupNumber) return res.status(400).json({ error: 'Champs obligatoires' });
  const name = fullName.trim(), group = groupNumber.trim();
  if (name.length < 3) return res.status(400).json({ error: 'Nom trop court' });

  const db = getDB();
  const submitted = db.prepare('SELECT * FROM students WHERE full_name=? AND group_number=? AND submitted=1').get(name, group);
  if (submitted) { db.close(); return res.status(409).json({ error: 'Vous avez déjà passé cet examen', score: submitted.score, total: submitted.total_questions }); }

  const active = db.prepare('SELECT * FROM students WHERE full_name=? AND group_number=? AND submitted=0').get(name, group);
  if (active) { db.close(); return res.json({ session: active.session_token, startTime: active.start_time, resumed: true }); }

  const token = uuidv4(), start = new Date().toISOString();
  db.prepare('INSERT INTO students (session_token,full_name,group_number,start_time) VALUES (?,?,?,?)').run(token, name, group, start);
  db.close();
  res.json({ session: token, startTime: start, resumed: false });
});

app.get('/api/questions', (req, res) => {
  const session = req.headers['x-session-token'];
  if (!session) return res.status(401).json({ error: 'Session invalide' });

  const questions = loadQuestions();
  const safe = questions.map((q, i) => ({ index: i, question: q.question, options: q.options, category: q.category || '' }));

  const db = getDB();
  const student = db.prepare('SELECT id FROM students WHERE session_token=?').get(session);
  let saved = [];
  if (student) saved = db.prepare('SELECT question_index, selected_answer FROM answers WHERE student_id=?').all(student.id);
  db.close();
  res.json({ questions: safe, savedAnswers: saved });
});

app.post('/api/answer', (req, res) => {
  const session = req.headers['x-session-token'];
  const { questionIndex, selectedAnswer } = req.body;
  if (!session) return res.status(401).json({ error: 'Session invalide' });

  const questions = loadQuestions();
  const q = questions[questionIndex];
  if (!q) return res.status(400).json({ error: 'Question invalide' });

  const db = getDB();
  const student = db.prepare('SELECT id, submitted FROM students WHERE session_token=?').get(session);
  if (!student) { db.close(); return res.status(401).json({ error: 'Session invalide' }); }
  if (student.submitted) { db.close(); return res.status(400).json({ error: 'Déjà soumis' }); }

  const isCorrect = selectedAnswer === q.correct ? 1 : 0;
  db.prepare('INSERT INTO answers (student_id,question_index,selected_answer,is_correct) VALUES (?,?,?,?) ON CONFLICT(student_id,question_index) DO UPDATE SET selected_answer=excluded.selected_answer, is_correct=excluded.is_correct').run(student.id, questionIndex, selectedAnswer, isCorrect);
  const count = db.prepare('SELECT COUNT(*) as c FROM answers WHERE student_id=?').get(student.id);
  db.close();
  res.json({ saved: true, answeredCount: count.c });
});

app.post('/api/submit', (req, res) => {
  const session = req.headers['x-session-token'];
  if (!session) return res.status(401).json({ error: 'Session invalide' });

  const db = getDB();
  const student = db.prepare('SELECT * FROM students WHERE session_token=?').get(session);
  if (!student) { db.close(); return res.status(401).json({ error: 'Session invalide' }); }
  if (student.submitted) { db.close(); return res.json({ score: student.score, totalQuestions: student.total_questions, percentage: Math.round((student.score/student.total_questions)*100) }); }

  const result = db.prepare('SELECT COUNT(*) as total, SUM(is_correct) as correct FROM answers WHERE student_id=?').get(student.id);
  const totalQ = loadQuestions().length;
  const score = result.correct || 0;
  db.prepare('UPDATE students SET submitted=1, score=?, total_questions=?, end_time=? WHERE id=?').run(score, totalQ, new Date().toISOString(), student.id);
  db.close();
  res.json({ score, totalQuestions: totalQ, answeredCount: result.total, percentage: Math.round((score/totalQ)*100), fullName: student.full_name, groupNumber: student.group_number });
});

app.get('/api/results', (req, res) => {
  const pass = req.headers['x-admin-password'];
  if (pass !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Non autorisé' });
  const db = getDB();
  const results = db.prepare('SELECT full_name, group_number, score, total_questions, submitted, start_time, end_time, (SELECT COUNT(*) FROM answers WHERE student_id=students.id) as answered_count FROM students ORDER BY submitted DESC, score DESC, group_number, full_name').all();
  db.close();
  res.json({ results });
});

app.get('/api/results-public', (_, res) => {
  const db = getDB();
  const results = db.prepare('SELECT full_name, group_number, score, total_questions FROM students WHERE submitted=1 ORDER BY score DESC, group_number, full_name').all();
  db.close();
  res.json({ results: results.map(r => ({ fullName: r.full_name, groupNumber: r.group_number, score: r.score, totalQuestions: r.total_questions, percentage: Math.round((r.score/r.total_questions)*100) })) });
});

app.delete('/api/cleanup', (req, res) => {
  const pass = req.headers['x-admin-password'];
  if (pass !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Non autorisé' });
  [DB_PATH, DB_PATH+'-wal', DB_PATH+'-shm'].forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });
  res.json({ message: 'Données supprimées' });
});

app.get('/api/my-score', (req, res) => {
  const session = req.headers['x-session-token'];
  if (!session) return res.status(401).json({ error: 'Session invalide' });
  const db = getDB();
  const student = db.prepare('SELECT id FROM students WHERE session_token=?').get(session);
  if (!student) { db.close(); return res.json({ correct: 0 }); }
  const r = db.prepare('SELECT SUM(is_correct) as correct FROM answers WHERE student_id=?').get(student.id);
  db.close();
  res.json({ correct: r.correct || 0 });
});

app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/resultats', (_, res) => res.sendFile(path.join(__dirname, 'public', 'results.html')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🐧 ${EXAM_TITLE} — Port ${PORT}`));
