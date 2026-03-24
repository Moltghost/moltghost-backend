import {
  pgTable,
  text,
  boolean,
  integer,
  real,
  timestamp,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createId } from "@paralleldrive/cuid2";

// ─── Enums ───────────────────────────────────────────────────────────────────

export const deploymentModeEnum = pgEnum("deployment_mode", [
  "dedicated",
  "shared",
  "external",
]);

export const deploymentStatusEnum = pgEnum("deployment_status", [
  "pending",
  "provisioning",
  "starting",
  "running",
  "stopped",
  "failed",
]);

// ─── Users ───────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  // id = Privy user ID (did:privy:...)
  id: text("id").primaryKey(),
  walletAddress: text("wallet_address"),
  email: text("email"),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Models ──────────────────────────────────────────────────────────────────

export const models = pgTable("models", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  size: text("size").notNull(),
  desc: text("desc").notNull(),
  recommended: boolean("recommended").notNull().default(false),
  image: text("image").notNull(),
  minVram: integer("min_vram").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── Deployments ─────────────────────────────────────────────────────────────

export const deployments = pgTable("deployments", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),

  // Owner
  userId: text("user_id")
    .notNull()
    .references(() => users.id),

  // Agent identity
  agentName: text("agent_name"),
  agentDescription: text("agent_description"),

  // Step 1/5 – deployment mode
  mode: deploymentModeEnum("mode").notNull(),

  // Step 2/5 – model (denormalized for immutable history)
  modelId: text("model_id")
    .notNull()
    .references(() => models.id),
  modelLabel: text("model_label").notNull(),
  modelSize: text("model_size").notNull(),
  modelImage: text("model_image").notNull(),
  modelMinVram: integer("model_min_vram").notNull(),

  // Step 3/5 – agent settings
  skills: jsonb("skills").$type<string[]>().notNull().default([]),
  memory: jsonb("memory")
    .$type<{
      enablePrivateMemory: boolean;
      persistentMemory: boolean;
      encryption: boolean;
    }>()
    .notNull()
    .default({
      enablePrivateMemory: false,
      persistentMemory: false,
      encryption: false,
    }),
  agentBehavior: jsonb("agent_behavior")
    .$type<{
      autonomousMode: boolean;
      taskTimeout: number;
      maxConcurrentTasks: number;
    }>()
    .notNull()
    .default({ autonomousMode: false, taskTimeout: 30, maxConcurrentTasks: 3 }),
  notifications: jsonb("notifications")
    .$type<{
      webhookNotifications: boolean;
      emailAlerts: boolean;
      taskReports: boolean;
    }>()
    .notNull()
    .default({
      webhookNotifications: false,
      emailAlerts: false,
      taskReports: false,
    }),
  autoSleep: jsonb("auto_sleep")
    .$type<{
      enableAutoSleep: boolean;
      idleTimeout: number;
    }>()
    .notNull()
    .default({ enableAutoSleep: false, idleTimeout: 15 }),

  // RunPod / infra (nullable until provisioned)
  podId: text("pod_id"),
  tunnelId: text("tunnel_id"),
  tunnelToken: text("tunnel_token"),
  agentDomain: text("agent_domain"),
  dnsRecordId: text("dns_record_id"),

  // Lifecycle
  status: deploymentStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Deployment Logs ─────────────────────────────────────────────────────────

export const deploymentLogs = pgTable("deployment_logs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  deploymentId: text("deployment_id")
    .notNull()
    .references(() => deployments.id, { onDelete: "cascade" }),
  level: text("level").notNull().default("info"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── Inferred Types ───────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Model = typeof models.$inferSelect;
export type NewModel = typeof models.$inferInsert;
export type Deployment = typeof deployments.$inferSelect;
export type NewDeployment = typeof deployments.$inferInsert;
export type DeploymentLog = typeof deploymentLogs.$inferSelect;
export type NewDeploymentLog = typeof deploymentLogs.$inferInsert;
