import { Db } from 'mongodb';
import { JWTPayload, User } from '../types/index.js';
import { getConfig } from '../config/env.js';

// Helper to recursively search for the $where operator
function hasWhereOperator(obj: any): boolean {
  if (!obj || typeof obj !== 'object') {
    return false;
  }
  
  if (Array.isArray(obj)) {
    return obj.some(item => hasWhereOperator(item));
  }

  for (const key in obj) {
    if (key === '$where') {
      return true;
    }
    if (hasWhereOperator(obj[key])) {
      return true;
    }
  }
  
  return false;
}

// Helper to recursively check for destructive keywords, ignoring string values
function hasDestructiveKeywords(obj: any): boolean {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  const blockedKeywords = ['delete', 'drop', 'truncate', 'remove', 'eval'];

  if (Array.isArray(obj)) {
    return obj.some(item => hasDestructiveKeywords(item));
  }

  for (const key in obj) {
    const lowerKey = key.toLowerCase();
    if (blockedKeywords.some(keyword => lowerKey.includes(keyword))) {
      return true;
    }

    const value = obj[key];
    if (typeof value === 'string') {
      continue;
    }

    if (hasDestructiveKeywords(value)) {
      return true;
    }
  }

  return false;
}

/**
 * Gets the list of student IDs enrolled in classes taught by a specific teacher
 */
async function getTeacherStudents(teacherId: string, db: Db): Promise<string[]> {
  const teacher = await db.collection<User>('users').findOne({ _id: teacherId, role: 'teacher' });
  if (!teacher || !teacher.assignedClassIds || teacher.assignedClassIds.length === 0) {
    return [];
  }

  const students = await db.collection<User>('users').find({
    role: 'student',
    classId: { $in: teacher.assignedClassIds }
  }).toArray();

  return students.map(s => s._id);
}

/**
 * Layer 1: Relationship-Based Access Control (ReBAC)
 */
async function enforceRebac(
  actor: JWTPayload,
  collection: string,
  filter: any,
  directStudentId: string | null, // Target studentId (if querying/updating student)
  directClassId: string | null,   // Target classId (if running class stats)
  isWrite: boolean,
  db: Db
): Promise<void> {
  const { role, userId } = actor;

  // 1. Admin: Complete bypass
  if (role === 'admin') {
    return;
  }

  // 2. Student: Can only view their own marks.
  if (role === 'student') {
    if (isWrite) {
      throw new Error(`Access Denied: Students are not authorized to modify database records.`);
    }

    if (collection !== 'marks') {
      throw new Error(`Access Denied: Students can only access the "marks" collection.`);
    }

    // Direct Class stats check: Students are blocked from querying class statistics
    if (directClassId) {
      throw new Error(`Access Denied: Students are not authorized to view class statistics.`);
    }

    // Direct Student checks: Must match their own userId
    if (directStudentId && directStudentId !== userId) {
      throw new Error(`Access Denied: You can only view your own academic records.`);
    }

    // Raw Query check: Filter must be strictly limited to their own studentId
    if (!directStudentId && !directClassId) {
      const studentIdFilter = filter.studentId;
      if (studentIdFilter !== userId && studentIdFilter?.['$eq'] !== userId) {
        throw new Error(`Access Denied: Queries must strictly filter by your own studentId (${userId}).`);
      }
    }
    return;
  }

  // 3. Teacher: Can access marks/stats for classes they teach.
  if (role === 'teacher') {
    if (collection !== 'marks' && collection !== 'users' && collection !== 'classes') {
      throw new Error(`Access Denied: Teachers cannot access the "${collection}" collection.`);
    }

    if (collection === 'users' && isWrite) {
      throw new Error(`Access Denied: Teachers cannot modify users.`);
    }

    if (collection === 'classes' && isWrite) {
      throw new Error(`Access Denied: Teachers cannot modify classes.`);
    }

    // Fetch teacher details
    const teacher = await db.collection<User>('users').findOne({ _id: userId, role: 'teacher' });
    const assignedClassIds = teacher?.assignedClassIds || [];

    // Check Class-based access (e.g. statistics, highest, lowest)
    if (directClassId) {
      if (!assignedClassIds.includes(directClassId)) {
        throw new Error(`Access Denied: You are not assigned to teach class "${directClassId}".`);
      }
      if (!directStudentId) {
        return;
      }
    }

    // Check Student-based access (e.g. upserting or fetching marks for a student)
    if (directStudentId) {
      const student = await db.collection<User>('users').findOne({ _id: directStudentId, role: 'student' });
      if (!student || !student.classId || !assignedClassIds.includes(student.classId)) {
        throw new Error(`Access Denied: Student is not enrolled in any of your assigned classes.`);
      }
      return;
    }

    // If querying classes collection for reading all classes (list_classes), we allow it
    if (collection === 'classes' && !isWrite) {
      return;
    }

    // Raw Query verification: Must restrict to authorized students or classes
    const classIdFilter = filter.classId;
    if (classIdFilter) {
      if (typeof classIdFilter === 'string') {
        if (!assignedClassIds.includes(classIdFilter)) {
          throw new Error(`Access Denied: Query targets a class outside your assignments.`);
        }
      } else if (classIdFilter && typeof classIdFilter === 'object') {
        if (classIdFilter['$eq'] && !assignedClassIds.includes(classIdFilter['$eq'])) {
          throw new Error(`Access Denied: Query targets a class outside your assignments.`);
        } else if (Array.isArray(classIdFilter['$in'])) {
          const unauthorized = classIdFilter['$in'].some((cid: string) => !assignedClassIds.includes(cid));
          if (unauthorized) {
            throw new Error(`Access Denied: Query contains classes outside your assignments.`);
          }
        }
      }
      return;
    }

    const studentIdFilter = filter.studentId || filter._id;
    if (studentIdFilter) {
      const authorizedStudentIds = await getTeacherStudents(userId, db);
      if (typeof studentIdFilter === 'string') {
        if (!authorizedStudentIds.includes(studentIdFilter)) {
          throw new Error(`Access Denied: Query targets a student outside your assigned classes.`);
        }
      } else if (studentIdFilter && typeof studentIdFilter === 'object') {
        if (studentIdFilter['$eq'] && !authorizedStudentIds.includes(studentIdFilter['$eq'])) {
          throw new Error(`Access Denied: Query targets a student outside your assigned classes.`);
        } else if (Array.isArray(studentIdFilter['$in'])) {
          const unauthorized = studentIdFilter['$in'].some((id: string) => !authorizedStudentIds.includes(id));
          if (unauthorized) {
            throw new Error(`Access Denied: Query contains students outside your assigned classes.`);
          }
        }
      }
      return;
    }

    throw new Error(`Access Denied: Teacher queries must restrict results by classId or studentId.`);
  }

  throw new Error(`Access Denied: Unknown role "${role}"`);
}

/**
 * Layer 2: Query Firewall
 */
function enforceFirewall(collection: string, filter: any): void {
  if (collection.toLowerCase().includes('system.')) {
    throw new Error(`Firewall Alert: Access to system collections is blocked.`);
  }

  if (hasWhereOperator(filter)) {
    throw new Error(`Firewall Alert: Use of the $where operator is strictly blocked.`);
  }
}

/**
 * Layer 3: Query Sanitation
 */
function enforceSanitation(filter: any, config = getConfig()): void {
  if (config.security.allowDestructiveCommands) {
    return;
  }

  if (hasDestructiveKeywords(filter)) {
    throw new Error(`Security Alert: Destructive query commands (delete, drop, remove, etc.) are blocked in Production.`);
  }
}

/**
 * Unified entry point for the security pipeline.
 */
export async function runSecurityPipeline(
  actor: JWTPayload,
  collection: string,
  filter: any,
  directStudentId: string | null,
  directClassId: string | null,
  isWrite: boolean,
  db: Db
): Promise<void> {
  const config = getConfig();

  if (config.security.enableFirewall) {
    enforceFirewall(collection, filter);
  }

  if (config.security.enableSanitation) {
    enforceSanitation(filter, config);
  }

  if (config.security.enableRebac) {
    await enforceRebac(actor, collection, filter, directStudentId, directClassId, isWrite, db);
  }
}
