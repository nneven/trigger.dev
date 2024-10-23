import { TaskCoordinator } from "@trigger.dev/coordinator";
import * as promClient from "prom-client";
promClient.collectDefaultMetrics();

const coordinator = new TaskCoordinator({
  port: Number(process.env.HTTP_SERVER_PORT || 8020),
  nodeName: process.env.NODE_NAME,
});
coordinator.listen();
