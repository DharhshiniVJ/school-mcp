import { getDb, closeDb } from '../config/db.js';
import { getConfig } from '../config/env.js';
import { hashPassword } from '../security/jwt.js';
import { User, Class, Mark } from '../types/index.js';

async function seed() {
  const env = process.env.NODE_ENV || 'staging';
  const config = getConfig();

  console.log(`[Seeder] Starting seed script. Target environment: "${env}"`);

  // --- Strict Production Safeguards ---
  if (env === 'production') {
    throw new Error('CRITICAL SAFETY BLOCK: Cannot run seed script in "production" environment!');
  }

  const dbUri = config.database.uri;
  if (dbUri.includes('27118') || config.database.dbName.includes('production')) {
    throw new Error('CRITICAL SAFETY BLOCK: Database configuration points to Production DB/Port. Seeding aborted!');
  }

  try {
    const db = await getDb();

    // 1. Clear existing collections
    console.log('[Seeder] Cleaning existing collections...');
    await db.collection<User>('users').deleteMany({});
    await db.collection<Class>('classes').deleteMany({});
    await db.collection<Mark>('marks').deleteMany({});

    // 2. Insert Classes
    console.log('[Seeder] Seeding classes...');
    const classes: Class[] = [
      { _id: 'class-math-101', name: 'Mathematics 101' },
      { _id: 'class-science-101', name: 'General Science 101' },
      { _id: 'class-english-101', name: 'English Literature 101' },
    ];
    await db.collection<Class>('classes').insertMany(classes);

    // 3. Create Hashed Passwords
    console.log('[Seeder] Hashing credentials...');
    const adminPassword = await hashPassword('admin123');
    const teacherPassword = await hashPassword('teacher123');
    const studentPassword = await hashPassword('student123');

    // 4. Insert Users (Admin, Teachers, Students)
    console.log('[Seeder] Seeding users...');
    const users: User[] = [
      // Admins
      {
        _id: 'user-admin-1',
        email: 'admin@school.edu',
        password: adminPassword,
        role: 'admin',
        name: 'Principal Skinner',
      },
      // Teachers
      {
        _id: 'user-teacher-alice',
        email: 'teacher.alice@school.edu',
        password: teacherPassword,
        role: 'teacher',
        name: 'Alice Hoover',
        assignedClassIds: ['class-math-101', 'class-science-101'],
      },
      {
        _id: 'user-teacher-bob',
        email: 'teacher.bob@school.edu',
        password: teacherPassword,
        role: 'teacher',
        name: 'Bob Krabappel',
        assignedClassIds: ['class-english-101'],
      },
      // Students
      {
        _id: 'user-student-charlie',
        email: 'student.charlie@school.edu',
        password: studentPassword,
        role: 'student',
        name: 'Charlie Simpson',
        classId: 'class-math-101',
      },
      {
        _id: 'user-student-david',
        email: 'student.david@school.edu',
        password: studentPassword,
        role: 'student',
        name: 'David Gumble',
        classId: 'class-science-101',
      },
      {
        _id: 'user-student-eve',
        email: 'student.eve@school.edu',
        password: studentPassword,
        role: 'student',
        name: 'Eve Bouvier',
        classId: 'class-math-101',
      },
      {
        _id: 'user-student-frank',
        email: 'student.frank@school.edu',
        password: studentPassword,
        role: 'student',
        name: 'Frank Grimes Jr.',
        classId: 'class-english-101',
      },
    ];
    await db.collection<User>('users').insertMany(users);

    // 5. Insert Marks
    console.log('[Seeder] Seeding marks...');
    const marks: Mark[] = [
      {
        studentId: 'user-student-charlie',
        classId: 'class-math-101',
        mark: 95,
        comments: 'Excellent work in calculus.',
        updatedAt: new Date().toISOString(),
        updatedBy: 'user-teacher-alice',
      },
      {
        studentId: 'user-student-eve',
        classId: 'class-math-101',
        mark: 90,
        comments: 'Good effort, very active in class discussions.',
        updatedAt: new Date().toISOString(),
        updatedBy: 'user-teacher-alice',
      },
      {
        studentId: 'user-student-david',
        classId: 'class-science-101',
        mark: 87,
        comments: 'Great lab reports. Needs to focus on final exams.',
        updatedAt: new Date().toISOString(),
        updatedBy: 'user-teacher-alice',
      },
      {
        studentId: 'user-student-frank',
        classId: 'class-english-101',
        mark: 82,
        comments: 'Solid essays, very punctual.',
        updatedAt: new Date().toISOString(),
        updatedBy: 'user-teacher-bob',
      },
    ];
    await db.collection<Mark>('marks').insertMany(marks);

    console.log('[Seeder] Database seeding completed successfully.');
  } catch (error) {
    console.error('[Seeder] Database seeding failed:', error);
  } finally {
    await closeDb();
  }
}

seed().catch(console.error);
