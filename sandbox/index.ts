import { Time } from '@geeebe/common';
import { Service } from './../src/service';
import { Graceful } from './../src/shutdown';

class MyService implements Service {
  public start = () => Promise.resolve();
  public stop = () => Promise.resolve();
  public dispose = () => Promise.resolve();
}

Graceful.service(Time.seconds(15), (active) => Service.combine(
  new MyService(),
));
