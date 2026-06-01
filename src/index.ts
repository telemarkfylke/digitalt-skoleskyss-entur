import dotenv from 'dotenv';
import { DatabaseService } from './services/database.service';
import { appLogger, flushLogs } from './services/logger.service';
import { StudentService } from './services/student.service';

// Load environment variables
dotenv.config();

class Application {
  private databaseService: DatabaseService;
  private studentService: StudentService;

  constructor() {
    this.databaseService = new DatabaseService();
    this.studentService = new StudentService(this.databaseService);
  }

  async start(): Promise<void> {
    try {
      appLogger.debug('Starting application');
      
      // Test database connection
      await this.databaseService.connect();
      appLogger.debug('Database connected successfully');
      
      appLogger.debug('Fetching videregaaende students that end in 2026');
      const students = await this.studentService.getVideregaaendeStudents('2026', '2027');
      appLogger.debug('Found {StudentCount} students', students.length);
      
      if (students.length > 0) {
        appLogger.debug('First student: {StudentJson}', JSON.stringify(students[0]));
        appLogger.debug('Second student: {StudentJson}', JSON.stringify(students[1]));
        appLogger.debug('Third student: {StudentJson}', JSON.stringify(students[2]));
        appLogger.debug('Fourth student: {StudentJson}', JSON.stringify(students[3]));
        appLogger.debug('Fifth student: {StudentJson}', JSON.stringify(students[4]));
        appLogger.debug('Sixth student: {StudentJson}', JSON.stringify(students[5]));
      }
      
      appLogger.debug('Finished, shutting down application');

      // Shutdown application after processing
      await this.shutdown();
      await flushLogs();
      process.exit(0);
    } catch (error: any) {
      appLogger.error('Failed to start application: {ErrorMessage}', error?.message || String(error));
      await flushLogs();
      process.exit(1);
    }
  }

  async shutdown(): Promise<void> {
    try {
      appLogger.debug('Shutting down application');
      await this.databaseService.disconnect();
      appLogger.debug('Application shut down successfully');
    } catch (error: any) {
      appLogger.error('Error during shutdown: {ErrorMessage}', error?.message || String(error));
    }
  }
}

// Application entry point
const app = new Application();

// Start the application
app.start().catch((error) => {
  appLogger.error('Unhandled error: {ErrorMessage}', error?.message || String(error));
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  appLogger.debug('Received SIGINT, shutting down gracefully');
  await app.shutdown();
  await flushLogs();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  appLogger.debug('Received SIGTERM, shutting down gracefully');
  await app.shutdown();
  await flushLogs();
  process.exit(0);
});