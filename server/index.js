
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';
import { PrismaNeonHTTP } from '@prisma/adapter-neon';

import { GoogleGenAI } from '@google/genai';
import multer from 'multer';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const app = express();
const adapter = new PrismaNeonHTTP(process.env.DATABASE_URL, {});
const prisma = new PrismaClient({ adapter });

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Store uploaded files in memory, maximum 5 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

// Require users to log in
function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Please log in' });
  }

  next();
}

app.use(express.json());

// Sessions
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-secret',
  resave: false,
  saveUninitialized: false,
}));

// Health route
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is alive' });
});

// Register route
app.post('/api/register', async (req, res) => {
  const { email, name, password } = req.body;
  const hash = await bcrypt.hash(password, 10);

  try {
    const user = await prisma.user.create({
      data: { email, name, password: hash },
    });

    req.session.userId = user.id;
    res.json({ id: user.id, name: user.name });

  } catch (e) {
    res.status(400).json({ error: 'Email already in use' });
  }
});


 // LOGIN
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) return res.status(401).json({ error: 'No such user' });

  const ok = await bcrypt.compare(password, user.password);

  if (!ok) return res.status(401).json({ error: 'Wrong password' });

  req.session.userId = user.id;
  res.json({ id: user.id, name: user.name });
});

// WHO AM I
app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });

  const user = await prisma.user.findUnique({
    where: { id: req.session.userId }
  });

  res.json({ user: user ? { id: user.id, name: user.name } : null });
});

// LOGOUT
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});



// UPLOAD: Receive a file, extract its text, and save it
app.post('/api/upload', requireLogin, upload.single('file'), async (req, res) => {
  try {
    let text = '';

    if (req.file.mimetype === 'application/pdf') {
      const parsed = await pdfParse(req.file.buffer);
      text = parsed.text;
    } else {
      text = req.file.buffer.toString('utf-8');
    }

    const doc = await prisma.document.create({
      data: {
        title: req.file.originalname,
        content: text,
        userId: req.session.userId
      },
    });

    res.json({
      id: doc.id,
      title: doc.title,
      chars: text.length
    });

  } catch (e) {
    res.status(400).json({
      error: 'Could not read that file. Try a text-based PDF or a .txt file.'
    });
  }
});


 // CHAT: Answer questions using only the uploaded document
app.post('/api/chat', requireLogin, async (req, res) => {
  const { message, documentId } = req.body;

  try {
    // Find the logged-in user's document
    const doc = await prisma.document.findFirst({
      where: {
        id: documentId,
        userId: req.session.userId
      },
    });

    if (!doc) {
      return res.status(404).json({
        error: 'Upload a document first.'
      });
    }

    // Ask Gemini using only the document content
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL,
      contents: message,
      config: {
        systemInstruction:
          `You are a study assistant. Answer the student's question using ONLY ` +
          `the course material below. If the answer is not in it, reply ` +
          `"That isn't covered in this material." Never use outside knowledge.\n\n` +
          `=== COURSE MATERIAL ===\n${doc.content}`,
      },
    });

    res.json({ reply: response.text });

  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: 'DocChat is unavailable right now.'
    });
  }
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));
