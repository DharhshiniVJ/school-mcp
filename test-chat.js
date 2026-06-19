import { chatWithAgent } from './server/dist/services/ollama.service.js';
import { initMcpClient } from './server/dist/services/mcp.service.js';

async function test() {
  await initMcpClient();
  
  const messages = [{ role: 'user', content: 'list all students' }];
  const userProfile = {
    userId: 'user-admin-skinner',
    name: 'Principal Skinner',
    role: 'admin',
    email: 'admin.skinner@school.edu',
    assignedClassIds: [],
    classIds: []
  };
  
  const result = await chatWithAgent(messages, 'dummy-token', userProfile);
  console.log('Result:', JSON.stringify(result, null, 2));
  process.exit(0);
}

test().catch(console.error);
