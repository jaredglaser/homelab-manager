export interface DockerContainer {
  name: string;
  cpuUtil: number; // percentage
  ramUtil: number; // percentage
  ioRead: number; // megabytes per second
  ioWrite: number; // megabytes per second
  networkRead: number; // megabits per second
  networkWrite: number; // megabits per second
  ioWait: number; // percentage
}
