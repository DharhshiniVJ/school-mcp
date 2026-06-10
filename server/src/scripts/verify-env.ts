import { getDb, closeDb } from '../config/db.js';
import { runSecurityPipeline } from '../security/pipeline.js';
import { JWTPayload } from '../types/index.js';
import { clearConfigCache } from '../config/env.js';

// Setup Mock JWT Tokens
const mockAdmin: JWTPayload = {
  userId: 'user-admin-1',
  email: 'admin@school.edu',
  role: 'admin',
  name: 'Principal Skinner',
};

const mockTeacherAlice: JWTPayload = {
  userId: 'user-teacher-alice',
  email: 'teacher.alice@school.edu',
  role: 'teacher',
  name: 'Alice Hoover', // Teaches Math-101 and Science-101
};

const mockTeacherBob: JWTPayload = {
  userId: 'user-teacher-bob',
  email: 'teacher.bob@school.edu',
  role: 'teacher',
  name: 'Bob Krabappel', // Teaches English-101
};

const mockStudentCharlie: JWTPayload = {
  userId: 'user-student-charlie',
  email: 'student.charlie@school.edu',
  role: 'student',
  name: 'Charlie Simpson', // Enrolled in Math-101
};

const mockStudentEve: JWTPayload = {
  userId: 'user-student-eve',
  email: 'student.eve@school.edu',
  role: 'student',
  name: 'Eve Bouvier', // Enrolled in Math-101
};

interface TestResult {
  name: string;
  success: boolean;
  errorMsg?: string;
}

const results: TestResult[] = [];

async function assertThrows(
  name: string,
  fn: () => Promise<any>,
  expectedErrorSub?: string
) {
  try {
    await fn();
    console.log(`❌ TEST FAILED: "${name}" (Expected error but query succeeded)`);
    results.push({ name, success: false, errorMsg: 'Expected error did not occur' });
  } catch (error: any) {
    const errorMsg = error.message || '';
    if (expectedErrorSub && !errorMsg.toLowerCase().includes(expectedErrorSub.toLowerCase())) {
      console.log(`❌ TEST FAILED: "${name}"\n   Expected error containing: "${expectedErrorSub}"\n   Got: "${errorMsg}"`);
      results.push({ name, success: false, errorMsg: `Got wrong error: ${errorMsg}` });
    } else {
      console.log(`✅ TEST PASSED: "${name}" (Expected block was enforced: "${errorMsg}")`);
      results.push({ name, success: true });
    }
  }
}

async function assertSucceeds(name: string, fn: () => Promise<any>) {
  try {
    await fn();
    console.log(`✅ TEST PASSED: "${name}"`);
    results.push({ name, success: true });
  } catch (error: any) {
    console.log(`❌ TEST FAILED: "${name}" (Query threw unexpected error: "${error.message}")`);
    results.push({ name, success: false, errorMsg: error.message });
  }
}

async function runTests() {
  console.log('--- STARTING PROGRAMMATIC INTEGRATION TESTS ---');
  const db = await getDb();

  // Test 1: Admin bypasses ReBAC
  await assertSucceeds('Admin can query any mark record', async () => {
    await runSecurityPipeline(mockAdmin, 'marks', { studentId: 'user-student-charlie' }, null, null, false, db);
  });

  // Test 2: Student accessing their own marks
  await assertSucceeds('Student can access their own marks', async () => {
    await runSecurityPipeline(mockStudentCharlie, 'marks', { studentId: 'user-student-charlie' }, 'user-student-charlie', null, false, db);
  });

  // Test 3: Student blocked from accessing others
  await assertThrows('Student is blocked from accessing other student marks (Direct tool)', async () => {
    await runSecurityPipeline(mockStudentCharlie, 'marks', {}, 'user-student-eve', null, false, db);
  }, 'view your own academic records');

  await assertThrows('Student is blocked from accessing other student marks (Raw query filter)', async () => {
    await runSecurityPipeline(mockStudentCharlie, 'marks', { studentId: 'user-student-eve' }, null, null, false, db);
  }, 'strictly filter by your own studentid');

  // Test 4: Student blocked from writing
  await assertThrows('Student is blocked from writing marks', async () => {
    await runSecurityPipeline(mockStudentCharlie, 'marks', {}, 'user-student-charlie', null, true, db);
  }, 'not authorized to modify database records');

  // Test 5: Teacher accessing their own student's marks
  await assertSucceeds('Teacher Alice can access Charlie (enrolled in Math-101, which Alice teaches)', async () => {
    await runSecurityPipeline(mockTeacherAlice, 'marks', { studentId: 'user-student-charlie' }, 'user-student-charlie', null, false, db);
  });

  // Test 6: Teacher blocked from students they don't teach
  await assertThrows('Teacher Alice blocked from Frank (enrolled in English-101, which Alice does NOT teach)', async () => {
    await runSecurityPipeline(mockTeacherAlice, 'marks', { studentId: 'user-student-frank' }, 'user-student-frank', null, false, db);
  }, 'not enrolled in any of your assigned classes');

  await assertThrows('Teacher Alice raw query blocked if searching for Frank', async () => {
    await runSecurityPipeline(mockTeacherAlice, 'marks', { studentId: 'user-student-frank' }, null, null, false, db);
  }, 'Query targets a student outside your assigned classes');

  // Test 7: Teacher writing marks for their own students
  await assertSucceeds('Teacher Alice can modify marks for Charlie', async () => {
    await runSecurityPipeline(mockTeacherAlice, 'marks', {}, 'user-student-charlie', null, true, db);
  });

  // Test 8: Teacher writing marks for non-assigned student
  await assertThrows('Teacher Alice blocked from writing marks for Frank', async () => {
    await runSecurityPipeline(mockTeacherAlice, 'marks', {}, 'user-student-frank', null, true, db);
  }, 'not enrolled in any of your assigned classes');

  // Test 9: Firewall blocks system collection queries
  await assertThrows('Firewall blocks access to system collections', async () => {
    await runSecurityPipeline(mockAdmin, 'system.users', {}, null, null, false, db);
  }, 'Access to system collections is blocked');

  // Test 10: Firewall blocks $where operator
  await assertThrows('Firewall blocks query with $where operator', async () => {
    await runSecurityPipeline(
      mockAdmin,
      'marks',
      { $where: "function() { return this.mark === 95; }" },
      null,
      null,
      false,
      db
    );
  }, 'use of the $where operator is strictly blocked');

  // Test 11: Sanitation blocks destructive commands (Mocking Production config)
  console.log('\nTesting Sanitation Block (Production simulation)...');
  await assertThrows('Sanitation blocks destructive keyword "delete" in query keys', async () => {
    const oldEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    clearConfigCache();
    try {
      await runSecurityPipeline(mockAdmin, 'marks', { delete: 'all' }, null, null, false, db);
    } finally {
      if (oldEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = oldEnv;
      }
      clearConfigCache();
    }
  }, 'destructive query commands');

  // Test 12: Teacher statistical calculations ReBAC checks
  console.log('\nTesting Class Statistics Access Permissions...');
  await assertSucceeds('Teacher Alice can query stats for Math-101 (she teaches)', async () => {
    await runSecurityPipeline(mockTeacherAlice, 'marks', {}, null, 'class-math-101', false, db);
  });

  await assertThrows('Teacher Alice blocked from stats for English-101 (she does not teach)', async () => {
    await runSecurityPipeline(mockTeacherAlice, 'marks', {}, null, 'class-english-101', false, db);
  }, 'not assigned to teach class');

  await assertThrows('Student Charlie blocked from stats for Math-101', async () => {
    await runSecurityPipeline(mockStudentCharlie, 'marks', {}, null, 'class-math-101', false, db);
  }, 'not authorized to view class statistics');

  // Test 13: Class details access ReBAC checks (get_class_details)
  console.log('\nTesting Class Details Access Permissions (get_class_details)...');
  await assertSucceeds('Admin can access class details for Math-101', async () => {
    await runSecurityPipeline(mockAdmin, 'classes', {}, null, 'class-math-101', false, db);
  });

  await assertSucceeds('Teacher Alice can access class details for Math-101 (she teaches)', async () => {
    await runSecurityPipeline(mockTeacherAlice, 'classes', {}, null, 'class-math-101', false, db);
  });

  await assertThrows('Teacher Alice blocked from class details for English-101 (she does not teach)', async () => {
    await runSecurityPipeline(mockTeacherAlice, 'classes', {}, null, 'class-english-101', false, db);
  }, 'not assigned to teach class');

  await assertThrows('Student Charlie blocked from class details for Math-101', async () => {
    await runSecurityPipeline(mockStudentCharlie, 'classes', {}, null, 'class-math-101', false, db);
  }, 'only access the "marks" collection');

  console.log('\n--- VERIFICATION TEST SUMMARY ---');
  const total = results.length;
  const passed = results.filter(r => r.success).length;
  const failed = total - passed;

  console.log(`Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) {
    console.error('❌ Some tests failed. Please review the pipeline logs.');
    process.exit(1);
  } else {
    console.log('✅ ALL SECURITY PIPELINE CHECKS PASSED.');
  }
}

runTests()
  .catch(console.error)
  .finally(async () => {
    await closeDb();
  });
