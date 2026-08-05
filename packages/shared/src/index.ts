import { z } from "zod";

export const projectStatusSchema = z.enum(["discovery", "plan_review", "active", "completed"]);
export const lessonStatusSchema = z.enum(["locked", "available", "in_progress", "completed"]);

export const lessonPlanSchema = z.object({
  title: z.string().min(1).max(160),
  objectives: z.array(z.string().min(1)).min(1).max(8),
  estimatedMinutes: z.number().int().min(10).max(240),
  completionCriteria: z.array(z.string().min(1)).min(1).max(8)
});

export const phaseSchema = z.object({
  title: z.string().min(1).max(160),
  goal: z.string().min(1).max(1000),
  lessons: z.array(lessonPlanSchema).min(1).max(90)
});

export const learningPlanSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(2000),
  learnerProfile: z.string().min(1).max(2000),
  duration: z.string().min(1).max(160),
  weeklyEffort: z.string().min(1).max(160),
  finalOutcomes: z.array(z.string().min(1)).min(1).max(12),
  phases: z.array(phaseSchema).min(1).max(20)
}).superRefine((plan, ctx) => {
  const total = plan.phases.reduce((sum, phase) => sum + phase.lessons.length, 0);
  if (total < 1 || total > 90) ctx.addIssue({code: z.ZodIssueCode.custom, message: "课程总数必须为 1–90 节", path: ["phases"]});
});

export const evaluationSchema = z.object({
  masteryScore: z.number().int().min(0).max(100),
  summary: z.string().min(1),
  mastered: z.array(z.string()),
  gaps: z.array(z.string()),
  evidence: z.array(z.string()),
  recommendation: z.enum(["complete", "continue"]),
  nextSteps: z.array(z.string()).min(1)
});

export type LearningPlan = z.infer<typeof learningPlanSchema>;
export type Evaluation = z.infer<typeof evaluationSchema>;
export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type LessonStatus = z.infer<typeof lessonStatusSchema>;

export interface UserPublic {
  id: number;
  username: string;
  role: "admin" | "user";
}

export interface AuthBootstrapResponse {
  authenticated: boolean;
  setupRequired: boolean;
  registrationEnabled: boolean;
  user: UserPublic | null;
}

export type UserStatus = "active" | "disabled";

export interface AdminUserSummary {
  id: number;
  username: string;
  role: "admin" | "user";
  status: UserStatus;
  createdAt: string;
  lastActiveAt: string;
  project: null | {
    title: string | null;
    status: ProjectStatus;
    completedLessons: number;
    totalLessons: number;
    percent: number;
  };
}

export interface AdminDashboardStats {
  totalUsers: number;
  activeUsers: number;
  disabledUsers: number;
  activeSessions: number;
  completedLessons: number;
  projects: Record<ProjectStatus, number>;
}

export interface AdminDashboardResponse {
  stats: AdminDashboardStats;
  users: AdminUserSummary[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  settings: { registrationEnabled: boolean };
  sharedProvider: SharedProviderPublic & { keyConfigured: boolean };
}

export interface SharedProviderPublic {
  configured: boolean;
  enabled: boolean;
  available: boolean;
  model: "deepseek-v4-flash";
  expiresAt: string | null;
}

export interface ProviderPublic {
  configured: boolean;
  id?: number;
  baseUrl?: string;
  model?: string;
  personalModel?: string;
  keyMask?: string;
  verifiedAt?: string | null;
  needsReauthorization?: boolean;
  preference: "shared" | "personal";
  activeSource: "shared" | "personal" | null;
  shared: SharedProviderPublic;
}

export interface LessonView {
  id: number; phaseIndex: number; lessonIndex: number; phaseTitle: string; title: string;
  objectives: string[]; completionCriteria: string[]; estimatedMinutes: number;
  status: LessonStatus; generatedBrief: string | null; masteryScore: number | null;
}

export interface MessageView { id: number; role: "user" | "assistant"; content: string; createdAt: string; }

export interface BootstrapResponse {
  user: UserPublic;
  provider: ProviderPublic;
  project: null | {id: number; status: ProjectStatus; title: string | null; plan: LearningPlan | null};
  lessons: LessonView[];
  messages: MessageView[];
  currentLessonId: number | null;
  progress: {completed: number; total: number; percent: number};
  reviewItems: string[];
}
