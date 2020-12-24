import 'reflect-metadata';

export namespace Service {
  export const combine = (...services: Service[]): Service => {
    return {
      destroy: () => Promise.all(services.map((service) => service.destroy())).then(),
      shutdown: () => Promise.all(services.map((service) => service.shutdown())).then(),
      start: () => Promise.all(services.map((service) => service.start())).then(),
    };
  };
}

export interface Service {
  destroy(): Promise<void>;
  shutdown(): Promise<void>;
  start(): Promise<void>;
}
