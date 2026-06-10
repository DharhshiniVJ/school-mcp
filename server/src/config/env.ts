import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import { EnvConfig } from '../types/index.js'; // Ensure .js extension for ESModules compatibility

let cachedConfig: EnvConfig | null = null;

export function clearConfigCache(): void {
  cachedConfig = null;
}

export function getConfig(): EnvConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const env = process.env.NODE_ENV || 'staging';
  
  // Resolve path relative to this file's location: server/dist/config/env.js
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const configPath = path.resolve(__dirname, '..', '..', '..', 'environments.yaml');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file not found at ${configPath}.`);
  }

  try {
    const fileContents = fs.readFileSync(configPath, 'utf8');
    const parsed = YAML.parse(fileContents);
    
    const envConfig = parsed[env];
    if (!envConfig) {
      throw new Error(`Configuration for environment "${env}" not found in environments.yaml`);
    }

    cachedConfig = envConfig as EnvConfig;
    return cachedConfig;
  } catch (error) {
    console.error(`Failed to parse environments.yaml:`, error);
    throw error;
  }
}
