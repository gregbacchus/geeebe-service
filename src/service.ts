import 'reflect-metadata';

export interface Service {
  start(): Promise<void>;
  stop(): Promise<void>;
}
