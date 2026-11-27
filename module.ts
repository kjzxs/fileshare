import { module } from "@prisma/composer";
import { rawPostgres } from "@prisma/composer-prisma-cloud";
import webService from "./src/service.ts";

export default module("prisma-fileshare-demo", ({ provision }) => {
  const db = provision(rawPostgres({ name: "database" }));
  provision(webService, { deps: { db } });
});
