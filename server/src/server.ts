import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getDb } from './config/db.js';
import { verifyToken, signToken } from './security/jwt.js';
import { runSecurityPipeline } from './security/pipeline.js';
import { JWTPayload, User, Mark, Class } from './types/index.js';

// Initialize the MCP Server
const server = new Server(
  {
    name: 'school-db-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tool schemas for listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_marks',
        description: 'Retrieve marks for students. Students can only see their own marks. Teachers can see marks for students in classes they teach. Admins can see all.',
        inputSchema: {
          type: 'object',
          properties: {
            studentId: {
              type: 'string',
              description: 'Optional ID of the student. If omitted, returns all permitted marks based on caller role.',
            },
          },
        },
      },
      {
        name: 'list_classes',
        description: 'Retrieve a list of all classes available in the school system.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_class_details',
        description: 'Retrieve detailed information about a specific class, including its name, assigned teacher, and enrolled students.',
        inputSchema: {
          type: 'object',
          properties: {
            classId: { type: 'string', description: 'The unique class ID (e.g. class-math-101).' },
          },
          required: ['classId'],
        },
      },
      {
        name: 'upsert_mark',
        description: 'Create or update a student mark for a class. Only authorized Teachers or Admins can perform this action.',
        inputSchema: {
          type: 'object',
          properties: {
            studentId: { type: 'string', description: 'The unique ID of the student.' },
            classId: { type: 'string', description: 'The class ID (e.g., class-math-101).' },
            mark: { type: 'number', description: 'The numeric score (0 to 100).' },
            comments: { type: 'string', description: 'Optional feedback comments.' },
          },
          required: ['studentId', 'classId', 'mark'],
        },
      },
      {
        name: 'get_highest_mark_student',
        description: 'Find the student with the highest marks in a particular class. Only authorized Teachers and Admins can access.',
        inputSchema: {
          type: 'object',
          properties: {
            classId: { type: 'string', description: 'The class ID (e.g., class-math-101).' },
          },
          required: ['classId'],
        },
      },
      {
        name: 'get_lowest_mark_student',
        description: 'Find the student with the lowest marks in a particular class. Only authorized Teachers and Admins can access.',
        inputSchema: {
          type: 'object',
          properties: {
            classId: { type: 'string', description: 'The class ID (e.g., class-math-101).' },
          },
          required: ['classId'],
        },
      },
      {
        name: 'calculate_class_statistics',
        description: 'Calculate class size, average score, and standard deviation. Only authorized Teachers and Admins can access.',
        inputSchema: {
          type: 'object',
          properties: {
            classId: { type: 'string', description: 'The class ID (e.g., class-math-101).' },
          },
          required: ['classId'],
        },
      },
      {
        name: 'get_student_best_performing_subject',
        description: 'Retrieve the class in which a student has scored the highest mark. Students can only check their own.',
        inputSchema: {
          type: 'object',
          properties: {
            studentId: { type: 'string', description: 'The student ID.' },
          },
          required: ['studentId'],
        },
      },
      {
        name: 'get_student_marks_summary',
        description: 'Retrieve a complete summary of all subject marks and the overall average score for a student. Students can only check their own.',
        inputSchema: {
          type: 'object',
          properties: {
            studentId: { type: 'string', description: 'The student ID.' },
          },
          required: ['studentId'],
        },
      },
      {
        name: 'manage_class',
        description: 'Admin tool to create or delete a class.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'delete'] },
            classId: { type: 'string', description: 'The class ID (e.g. class-math-101).' },
            className: { type: 'string', description: 'The display name of the class (required for create).' },
          },
          required: ['action', 'classId'],
        },
      },
      {
        name: 'manage_teacher_assignment',
        description: 'Admin tool to assign or unassign a teacher to a class.',
        inputSchema: {
          type: 'object',
          properties: {
            teacherId: { type: 'string', description: 'The unique user ID of the teacher.' },
            classId: { type: 'string', description: 'The class ID.' },
            action: { type: 'string', enum: ['assign', 'unassign'] },
          },
          required: ['teacherId', 'classId', 'action'],
        },
      },
      {
        name: 'manage_student_enrollment',
        description: 'Admin tool to enroll or unenroll a student in a class.',
        inputSchema: {
          type: 'object',
          properties: {
            studentId: { type: 'string', description: 'The unique user ID of the student.' },
            classId: { type: 'string', description: 'The class ID.' },
            action: { type: 'string', enum: ['enroll', 'unenroll'] },
          },
          required: ['studentId', 'classId', 'action'],
        },
      },
      {
        name: 'raw_query',
        description: 'Executes a direct find query against a collection. Subject to rigid pipeline checks.',
        inputSchema: {
          type: 'object',
          properties: {
            collection: { type: 'string', description: 'Collection name (marks, users, classes).' },
            filter: { type: 'object', description: 'MongoDB query filter object.' },
            options: { type: 'object', description: 'Optional MongoDB query options (e.g. projection, limit).' },
          },
          required: ['collection', 'filter'],
        },
      },
    ],
  };
});

// Helper to extract token and verify actor
function extractActor(params: any): JWTPayload {
  let token = params?._meta?.token;
  
  // Check inside arguments if passed there by the gateway client
  if (!token && params?.arguments?._meta?.token) {
    token = params.arguments._meta.token;
  }
  
  if (!token) {
    const env = process.env.NODE_ENV || 'staging';
    const mockRole = process.env.MOCK_ROLE;
    
    if (env === 'staging' && mockRole) {
      console.error(`[MCP] Missing _meta.token. Falling back to MOCK_ROLE: ${mockRole}`);
      if (mockRole === 'admin') {
        token = signToken({ userId: 'user-admin-1', email: 'admin@school.edu', role: 'admin', name: 'Admin User' });
      } else if (mockRole === 'teacher') {
        token = signToken({ userId: 'user-teacher-t1', email: 'teacher.t1@school.edu', role: 'teacher', name: 'Test Teacher' });
      } else if (mockRole === 'student') {
        token = signToken({ userId: 'user-student-s1', email: 'student.s1@school.edu', role: 'student', name: 'Test Student' });
      } else {
        throw new Error(`Access Denied: Invalid MOCK_ROLE "${mockRole}". Use "admin", "teacher", or "student".`);
      }
    } else {
      throw new Error('Access Denied: Missing authentication token (_meta.token)');
    }
  }
  
  return verifyToken(token);
}

// Tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const db = await getDb();

  try {
    const actor = extractActor(request.params);
    console.error(`[MCP] Executing tool "${name}" called by ${actor.role} (${actor.email})`);

    switch (name) {
      case 'get_marks': {
        const studentId = args?.studentId as string | undefined;
        
        // Pipeline validation
        await runSecurityPipeline(actor, 'marks', {}, studentId || null, null, false, db);

        let query: any = {};
        if (studentId) {
          query.studentId = studentId;
        } else {
          if (actor.role === 'student') {
            query.studentId = actor.userId;
          } else if (actor.role === 'teacher') {
            // Find students taught by teacher
            const teacher = await db.collection<User>('users').findOne({ _id: actor.userId });
            const assignedClassIds = teacher?.assignedClassIds || [];
            const students = await db.collection<User>('users')
              .find({ role: 'student', classId: { $in: assignedClassIds } })
              .toArray();
            const studentIds = students.map(s => s._id);
            query.studentId = { $in: studentIds };
          }
        }

        const marks = await db.collection<Mark>('marks').find(query).toArray();
        return {
          content: [{ type: 'text', text: JSON.stringify(marks, null, 2) }],
        };
      }

      case 'list_classes': {
        // Pipeline validation
        await runSecurityPipeline(actor, 'classes', {}, null, null, false, db);

        const classes = await db.collection<Class>('classes').find().toArray();
        
        // Resolve assigned teachers for each class
        const classesWithTeachers = await Promise.all(classes.map(async (cls) => {
          const teacher = await db.collection<User>('users').findOne({
            role: 'teacher',
            assignedClassIds: cls._id
          });
          return {
            classId: cls._id,
            className: cls.name,
            assignedTeacherName: teacher ? teacher.name : 'Unassigned',
            assignedTeacherEmail: teacher ? teacher.email : 'Unassigned'
          };
        }));

        return {
          content: [{ type: 'text', text: JSON.stringify(classesWithTeachers, null, 2) }],
        };
      }

      case 'get_class_details': {
        const classId = args?.classId as string;
        if (!classId) {
          throw new Error('classId is required');
        }

        // Helper to escape regex special characters
        const escapeRegex = (str: string) => str.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
        const queryStr = classId.trim();

        // Find the class matching the input classId case-insensitively against _id or name
        const cls = await db.collection<Class>('classes').findOne({
          $or: [
            { _id: { $regex: new RegExp(`^${escapeRegex(queryStr)}$`, 'i') } },
            { name: { $regex: new RegExp(`^${escapeRegex(queryStr)}$`, 'i') } }
          ]
        });

        if (!cls) {
          throw new Error(`Class "${classId}" does not exist.`);
        }

        const canonicalClassId = cls._id;

        // Pipeline validation using the canonical class ID
        await runSecurityPipeline(actor, 'classes', {}, null, canonicalClassId, false, db);

        // Fetch teacher assigned to the class
        const teacher = await db.collection<User>('users').findOne({
          role: 'teacher',
          assignedClassIds: canonicalClassId
        });

        // Fetch enrolled students
        const students = await db.collection<User>('users').find({
          role: 'student',
          classId: canonicalClassId
        }).toArray();

        const responseObj = {
          classId: canonicalClassId,
          className: cls.name,
          teacherName: teacher ? teacher.name : 'Unassigned',
          enrolledStudents: students.map(s => s.name)
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(responseObj, null, 2) }],
        };
      }

      case 'upsert_mark': {
        const studentId = args?.studentId as string;
        const classId = args?.classId as string;
        const markVal = Number(args?.mark);
        const comments = args?.comments as string | undefined;

        if (isNaN(markVal) || markVal < 0 || markVal > 100) {
          throw new Error('Invalid mark value. Mark must be a number between 0 and 100.');
        }

        // Pipeline validation
        await runSecurityPipeline(actor, 'marks', {}, studentId, null, true, db);

        // Verify class exists
        const cls = await db.collection<Class>('classes').findOne({ _id: classId });
        if (!cls) {
          throw new Error(`Class ${classId} does not exist.`);
        }

        // Verify student is enrolled in class
        const student = await db.collection<User>('users').findOne({ _id: studentId, role: 'student' });
        if (!student) {
          throw new Error(`Student ${studentId} does not exist.`);
        }
        if (student.classId !== classId) {
          throw new Error(`Student ${studentId} is not enrolled in class ${classId}.`);
        }

        const markData: Mark = {
          studentId,
          classId,
          mark: markVal,
          comments,
          updatedAt: new Date().toISOString(),
          updatedBy: actor.userId,
        };

        const result = await db.collection<Mark>('marks').updateOne(
          { studentId, classId },
          { $set: markData },
          { upsert: true }
        );

        return {
          content: [{
            type: 'text',
            text: `Mark successfully updated for student ${studentId} in class ${classId}. Mark: ${markVal}`,
          }],
        };
      }

      case 'get_highest_mark_student': {
        const classId = args?.classId as string;

        // Pipeline validation (Class-based access check)
        await runSecurityPipeline(actor, 'marks', {}, null, classId, false, db);

        // Find highest mark in class
        const topMarks = await db.collection<Mark>('marks')
          .find({ classId })
          .sort({ mark: -1 })
          .limit(1)
          .toArray();

        if (topMarks.length === 0) {
          return { content: [{ type: 'text', text: `No marks registered in class ${classId} yet.` }] };
        }

        const topMark = topMarks[0];
        const student = await db.collection<User>('users').findOne({ _id: topMark.studentId });

        return {
          content: [{
            type: 'text',
            text: `Highest scoring student in class "${classId}" is ${student?.name || topMark.studentId} with a mark of ${topMark.mark}%. Comments: "${topMark.comments || 'No comments'}"`
          }]
        };
      }

      case 'get_lowest_mark_student': {
        const classId = args?.classId as string;

        // Pipeline validation
        await runSecurityPipeline(actor, 'marks', {}, null, classId, false, db);

        // Find lowest mark in class
        const bottomMarks = await db.collection<Mark>('marks')
          .find({ classId })
          .sort({ mark: 1 })
          .limit(1)
          .toArray();

        if (bottomMarks.length === 0) {
          return { content: [{ type: 'text', text: `No marks registered in class ${classId} yet.` }] };
        }

        const bottomMark = bottomMarks[0];
        const student = await db.collection<User>('users').findOne({ _id: bottomMark.studentId });

        return {
          content: [{
            type: 'text',
            text: `Lowest scoring student in class "${classId}" is ${student?.name || bottomMark.studentId} with a mark of ${bottomMark.mark}%. Comments: "${bottomMark.comments || 'No comments'}"`
          }]
        };
      }

      case 'calculate_class_statistics': {
        const classId = args?.classId as string;

        // Pipeline validation
        await runSecurityPipeline(actor, 'marks', {}, null, classId, false, db);

        const marks = await db.collection<Mark>('marks').find({ classId }).toArray();
        
        if (marks.length === 0) {
          return {
            content: [{ type: 'text', text: `No marks registered in class ${classId}. Statistics cannot be calculated.` }]
          };
        }

        const totalStudents = marks.length;
        const sum = marks.reduce((acc, m) => acc + m.mark, 0);
        const average = Number((sum / totalStudents).toFixed(2));

        // Calculate Population Standard Deviation (σ)
        const variance = marks.reduce((acc, m) => acc + Math.pow(m.mark - average, 2), 0) / totalStudents;
        const stdDev = Number(Math.sqrt(variance).toFixed(2));

        const responseObj = {
          classId,
          totalStudents,
          classAverage: `${average}%`,
          standardDeviation: `${stdDev}`,
          highestMark: `${Math.max(...marks.map(m => m.mark))}%`,
          lowestMark: `${Math.min(...marks.map(m => m.mark))}%`
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(responseObj, null, 2) }]
        };
      }

      case 'get_student_best_performing_subject': {
        const studentId = args?.studentId as string;

        // Pipeline validation (Student self check)
        await runSecurityPipeline(actor, 'marks', {}, studentId, null, false, db);

        const bestMarks = await db.collection<Mark>('marks')
          .find({ studentId })
          .sort({ mark: -1 })
          .limit(1)
          .toArray();

        if (bestMarks.length === 0) {
          return { content: [{ type: 'text', text: 'No marks registered for this student yet.' }] };
        }

        const bestMark = bestMarks[0];
        const classObj = await db.collection<Class>('classes').findOne({ _id: bestMark.classId });

        return {
          content: [{
            type: 'text',
            text: `Best performing subject is "${classObj?.name || bestMark.classId}" (${bestMark.classId}) with a score of ${bestMark.mark}%.`
          }]
        };
      }

      case 'get_student_marks_summary': {
        const studentId = args?.studentId as string;

        // Pipeline validation
        await runSecurityPipeline(actor, 'marks', {}, studentId, null, false, db);

        const studentMarks = await db.collection<Mark>('marks').find({ studentId }).toArray();

        if (studentMarks.length === 0) {
          return { content: [{ type: 'text', text: 'No marks registered for this student yet.' }] };
        }

        const total = studentMarks.length;
        const sum = studentMarks.reduce((acc, m) => acc + m.mark, 0);
        const average = Number((sum / total).toFixed(2));

        // Fetch display names for classes
        const classesList = await db.collection<Class>('classes').find().toArray();
        const classMap = new Map(classesList.map(c => [c._id, c.name]));

        const marksList = studentMarks.map(m => ({
          classId: m.classId,
          className: classMap.get(m.classId) || m.classId,
          mark: `${m.mark}%`,
          feedback: m.comments || 'No feedback left'
        }));

        const responseObj = {
          studentId,
          overallAverage: `${average}%`,
          subjectsCount: total,
          subjects: marksList
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(responseObj, null, 2) }]
        };
      }

      case 'manage_class': {
        const action = args?.action as 'create' | 'delete';
        const classId = args?.classId as string;
        const className = args?.className as string | undefined;

        // Pipeline validation (Requires admin role)
        await runSecurityPipeline(actor, 'classes', {}, null, null, true, db);

        if (action === 'create') {
          if (!className) {
            throw new Error('className is required to create a class');
          }
          await db.collection<Class>('classes').updateOne(
            { _id: classId },
            { $set: { _id: classId, name: className } },
            { upsert: true }
          );
          return {
            content: [{ type: 'text', text: `Class "${classId}" (${className}) created successfully.` }],
          };
        } else {
          const result = await db.collection<Class>('classes').deleteOne({ _id: classId });
          // Also clean up any marks
          await db.collection<Mark>('marks').deleteMany({ classId });
          return {
            content: [{ type: 'text', text: `Class "${classId}" deleted. Removed matching marks. Deleted count: ${result.deletedCount}` }],
          };
        }
      }

      case 'manage_teacher_assignment': {
        const teacherId = args?.teacherId as string;
        const classId = args?.classId as string;
        const action = args?.action as 'assign' | 'unassign';

        // Pipeline validation (Requires admin role)
        await runSecurityPipeline(actor, 'users', {}, null, null, true, db);

        // Verify user is a teacher
        const teacher = await db.collection<User>('users').findOne({ _id: teacherId, role: 'teacher' });
        if (!teacher) {
          throw new Error(`User ${teacherId} is not registered as a teacher.`);
        }

        // Verify class exists
        const cls = await db.collection<Class>('classes').findOne({ _id: classId });
        if (!cls) {
          throw new Error(`Class ${classId} does not exist.`);
        }

        if (action === 'assign') {
          // Enforce Constraint: Every class can only have one teacher assigned to it
          const existingTeacher = await db.collection<User>('users').findOne({
            role: 'teacher',
            _id: { $ne: teacherId },
            assignedClassIds: classId
          });

          if (existingTeacher) {
            throw new Error(`Class ${classId} is already assigned to teacher ${existingTeacher.name} (${existingTeacher._id}).`);
          }

          await db.collection<User>('users').updateOne(
            { _id: teacherId },
            { $addToSet: { assignedClassIds: classId } }
          );
          return {
            content: [{ type: 'text', text: `Class ${classId} assigned to teacher ${teacherId}.` }],
          };
        } else {
          await db.collection<User>('users').updateOne(
            { _id: teacherId },
            { $pull: { assignedClassIds: classId } }
          );
          return {
            content: [{ type: 'text', text: `Class ${classId} unassigned from teacher ${teacherId}.` }],
          };
        }
      }

      case 'manage_student_enrollment': {
        const studentId = args?.studentId as string;
        const classId = args?.classId as string;
        const action = args?.action as 'enroll' | 'unenroll';

        // Pipeline validation (Requires admin role)
        await runSecurityPipeline(actor, 'users', {}, null, null, true, db);

        // Verify user is a student
        const student = await db.collection<User>('users').findOne({ _id: studentId, role: 'student' });
        if (!student) {
          throw new Error(`User ${studentId} is not registered as a student.`);
        }

        if (action === 'enroll') {
          // Verify class exists
          const cls = await db.collection<Class>('classes').findOne({ _id: classId });
          if (!cls) {
            throw new Error(`Class ${classId} does not exist.`);
          }
          await db.collection<User>('users').updateOne(
            { _id: studentId },
            { $set: { classId } }
          );
          return {
            content: [{ type: 'text', text: `Student ${studentId} enrolled in class ${classId}.` }],
          };
        } else {
          await db.collection<User>('users').updateOne(
            { _id: studentId },
            { $unset: { classId: '' } }
          );
          return {
            content: [{ type: 'text', text: `Student ${studentId} unenrolled from class.` }],
          };
        }
      }

      case 'raw_query': {
        const collection = args?.collection as string;
        const filter = args?.filter as any;
        const options = args?.options as any;

        // Pipeline validation
        await runSecurityPipeline(actor, collection, filter, null, null, false, db);

        const results = await db.collection(collection)
          .find(filter, options)
          .toArray();

        // Output Sanitation: Strip password hashes
        if (collection === 'users') {
          results.forEach((user: any) => {
            delete user.password;
          });
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
        };
      }

      default:
        throw new Error(`Unknown tool "${name}"`);
    }
  } catch (error: any) {
    console.error(`[MCP Error] Tool execution failed for "${name}":`, error);
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${error.message}` }],
    };
  }
});

// Start the server using stdio transport
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP Server] Running over stdio transport');
}

run().catch((error) => {
  console.error('[MCP Critical] Failed to start server:', error);
  process.exit(1);
});
