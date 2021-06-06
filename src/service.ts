import 'reflect-metadata';

export namespace Service {
  export const combine = (...services: Service[]): Service => {
    return {
      dispose: () => Promise.all(services.map((service) => service.dispose())).then(),
      start: () => Promise.all(services.map((service) => service.start())).then(),
      stop: () => Promise.all(services.map((service) => service.stop())).then(),
    };
  };
}

export interface Service {
  dispose(): Promise<unknown>;
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
}
