import { allocateDevPorts, launchWorkspaceDev, printEndpoints } from "./junrei-launcher.mjs";

const ports = await allocateDevPorts();
printEndpoints("dev", ports);
launchWorkspaceDev(ports);
