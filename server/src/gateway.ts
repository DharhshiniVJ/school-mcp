import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { getDb } from './config/db.js';
import { getConfig } from './config/env.js';
import { comparePassword, hashPassword, verifyToken, signToken } from './security/jwt.js';
import { callMcpTool } from './services/mcp.service.js';
import { chatWithAgent } from './services/ollama.service.js';
import { JWTPayload, User, Class } from './types/index.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for React frontend (Vite runs on port 5173 by default)
app.use(cors({
  origin: '*', // For dev simplicity; in production restrict to frontend URL
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Extend express Request to include the decoded JWT payload
interface AuthenticatedRequest extends Request {
  user?: JWTPayload;
  token?: string;
}

// Middleware to authenticate JWT tokens
function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required. Please log in.' });
  }

  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    req.token = token;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired session token.' });
  }
}

// Middleware to restrict access to Admins only
function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: Admin access required.' });
  }
  next();
}

// --- PUBLIC ROUTES ---

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', env: process.env.NODE_ENV || 'staging' });
});

// Login endpoint
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const db = await getDb();
    const user = await db.collection<User>('users').findOne({ email: email.toLowerCase() });

    if (!user || !user.password) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const isMatch = await comparePassword(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Sign JWT token
    const tokenPayload: JWTPayload = {
      userId: user._id,
      email: user.email,
      role: user.role,
      name: user.name,
      assignedClassIds: user.assignedClassIds,
      classId: user.classId
    };

    const token = signToken(tokenPayload);

    return res.json({
      token,
      user: {
        userId: user._id,
        email: user.email,
        role: user.role,
        name: user.name,
        assignedClassIds: user.assignedClassIds,
        classId: user.classId
      }
    });
  } catch (error: any) {
    console.error('[Gateway Auth] Login error:', error);
    return res.status(500).json({ error: `Login failed: ${error.message}` });
  }
});

// --- PROTECTED ADMIN ROUTES ---

// Get all users
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    // Exclude password hashes from results
    const users = await db.collection<User>('users').find({}, { projection: { password: 0 } }).toArray();
    res.json(users);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create a new user (Student / Teacher / Admin)
app.post('/api/admin/users', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res) => {
  const { userId, email, password, role, name, classId, assignedClassIds } = req.body;

  if (!userId || !email || !password || !role || !name) {
    return res.status(400).json({ error: 'Missing required fields: userId, email, password, role, name.' });
  }

  try {
    const db = await getDb();
    const existing = await db.collection('users').findOne({ $or: [{ _id: userId }, { email: email.toLowerCase() }] });
    if (existing) {
      return res.status(400).json({ error: 'A user with that ID or email already exists.' });
    }

    const hashedPassword = await hashPassword(password);

    const newUser: User = {
      _id: userId,
      email: email.toLowerCase(),
      password: hashedPassword,
      role,
      name,
      ...(role === 'student' && { classId }),
      ...(role === 'teacher' && { assignedClassIds: assignedClassIds || [] })
    };

    await db.collection<User>('users').insertOne(newUser);
    res.status(201).json({ message: `User ${name} created successfully as ${role}.` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get all classes
app.get('/api/admin/classes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const classes = await db.collection<Class>('classes').find().toArray();
    res.json(classes);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create a class (routed through MCP for pipeline validation check)
app.post('/api/admin/classes', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res) => {
  const { classId, className } = req.body;
  if (!classId || !className) {
    return res.status(400).json({ error: 'classId and className are required.' });
  }

  try {
    const mcpResponse = await callMcpTool('manage_class', { action: 'create', classId, className }, req.token!);
    if (mcpResponse.isError) {
      return res.status(400).json({ error: mcpResponse.content[0].text });
    }
    res.json({ message: mcpResponse.content[0].text });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a class (routed through MCP)
app.delete('/api/admin/classes/:id', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res) => {
  const classId = req.params.id;
  try {
    const mcpResponse = await callMcpTool('manage_class', { action: 'delete', classId }, req.token!);
    if (mcpResponse.isError) {
      return res.status(400).json({ error: mcpResponse.content[0].text });
    }
    res.json({ message: mcpResponse.content[0].text });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Assign class to Teacher (routed through MCP)
app.post('/api/admin/assign-teacher', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res) => {
  const { teacherId, classId, action } = req.body; // action: 'assign' | 'unassign'
  if (!teacherId || !classId || !action) {
    return res.status(400).json({ error: 'teacherId, classId, and action are required.' });
  }

  try {
    const mcpResponse = await callMcpTool('manage_teacher_assignment', { teacherId, classId, action }, req.token!);
    if (mcpResponse.isError) {
      return res.status(400).json({ error: mcpResponse.content[0].text });
    }
    res.json({ message: mcpResponse.content[0].text });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Enroll Student in class (routed through MCP)
app.post('/api/admin/enroll-student', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res) => {
  const { studentId, classId, action } = req.body; // action: 'enroll' | 'unenroll'
  if (!studentId || !classId || !action) {
    return res.status(400).json({ error: 'studentId, classId, and action are required.' });
  }

  try {
    const mcpResponse = await callMcpTool('manage_student_enrollment', { studentId, classId, action }, req.token!);
    if (mcpResponse.isError) {
      return res.status(400).json({ error: mcpResponse.content[0].text });
    }
    res.json({ message: mcpResponse.content[0].text });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- PROTECTED CHAT ROUTE ---

// Chat orchestration endpoint (calls Ollama agentic loop)
app.post('/api/chat', authenticateToken, async (req: AuthenticatedRequest, res) => {
  const { messages, activeClassId } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages array is required.' });
  }

  try {
    const actor = req.user!;
    const token = req.token!;

    console.error(`[Gateway Chat] Routing chat request for user ${actor.name} (${actor.role}) with activeClassId: ${activeClassId}`);
    
    // Call Ollama orchestrator passing conversation history, token, actor info, and class context
    const agentResponse = await chatWithAgent(
      messages,
      token,
      {
        userId: actor.userId,
        name: actor.name,
        role: actor.role,
        email: actor.email,
        assignedClassIds: actor.assignedClassIds,
        classId: actor.classId
      },
      activeClassId
    );

    res.json(agentResponse);
  } catch (error: any) {
    console.error('[Gateway Chat] Agent chat error:', error);
    // Never forward raw internal errors (e.g. HTML pages, stack traces) to the client
    const safeMessage = (error.message && !error.message.trim().startsWith('<'))
      ? error.message
      : 'The AI model is currently unavailable. Please try again later.';
    res.status(500).json({ error: safeMessage });
  }
});

// Start Express gateway server
app.listen(PORT, () => {
  console.error(`[Gateway Server] Express Gateway running on port ${PORT} (${process.env.NODE_ENV || 'staging'} mode)`);
});
