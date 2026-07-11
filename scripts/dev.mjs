import { launchWorkspaceDev, printEndpoints, reserveDevPorts } from "./junrei-launcher.mjs";

const { ports, release } = await reserveDevPorts();
printEndpoints("dev", ports);
launchWorkspaceDev(ports, release);
