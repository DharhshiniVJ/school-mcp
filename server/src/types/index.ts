export type UserRole = 'admin' | 'teacher' | 'student';

export interface JWTPayload {
  userId: string;
  email: string;
  role: UserRole;
  name: string;
}

export interface User {
  _id: string; // We will use plain strings or stringified ObjectIds for simplicity and ease of routing
  email: string;
  password?: string; // Hashed password, omitted from some client structures
  role: UserRole;
  name: string;
  assignedClassIds?: string[]; // Array of Class IDs for Teachers
  classId?: string; // Class ID for Students
}

export interface Class {
  _id: string; // E.g., "class-math-101"
  name: string;
}

export interface Mark {
  _id?: string;
  studentId: string;
  classId: string;
  mark: number; // E.g., 95, 87 (Numeric marks)
  comments?: string;
  updatedAt: string;
  updatedBy: string; // Teacher's userId
}

export interface EnvConfig {
  database: {
    uri: string;
    dbName: string;
  };
  jwt: {
    secret: string;
    expiresIn: string;
  };
  ollama: {
    endpoint: string;
    model: string;
  };
  security: {
    allowDestructiveCommands: boolean;
    enableFirewall: boolean;
    enableRebac: boolean;
    enableSanitation: boolean;
  };
}
