import { IHelmetConfiguration } from 'helmet';

export const DEFAULT_HELMET_OPTIONS: IHelmetConfiguration = {};

export const API_HELMET_OPTIONS: IHelmetConfiguration = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      objectSrc: ["'none'"],
      styleSrc: ["'none'"],
      upgradeInsecureRequests: true,
    },
  },
  dnsPrefetchControl: { allow: false },
  // expectCt?: boolean | IHelmetExpectCtConfiguration;
  // featurePolicy: IFeaturePolicyOptions,
  frameguard: true,
  hidePoweredBy: true,
  hpkp: false,
  ieNoOpen: true,
  noCache: true,
  noSniff: true,
  permittedCrossDomainPolicies: { permittedPolicies: 'none' },
  referrerPolicy: false,
};
