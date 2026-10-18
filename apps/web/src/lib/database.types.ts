/**
 * The slice of supabase/migrations/0001_initial.sql that the app reads and writes.
 * Kept by hand so the client is typed without a generation step; update it with the schema.
 */

export type Mastery = 'not_started' | 'attempted' | 'proficient' | 'mastered';
export type LabLevel = 'beginner' | 'intermediate' | 'advanced';
export type AgeBand = 'under_18' | '18_plus' | 'undisclosed';
export type PlatformRole = 'learner' | 'moderator' | 'admin';

export type ProfileRow = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  country: string | null;
  age_band: AgeBand;
  platform_role: PlatformRole;
  show_on_boards: boolean;
  xp: number;
  level: number;
  streak_weeks: number;
  last_proficient_week: string | null;
  created_at: string;
  updated_at: string;
};

export type ProfileUpdate = Partial<
  Pick<ProfileRow, 'username' | 'display_name' | 'avatar_url' | 'bio' | 'country' | 'age_band' | 'show_on_boards'>
>;

export type TopicProgressRow = {
  user_id: string;
  course_slug: string;
  unit_index: number;
  topic_index: number;
  mastery: Mastery;
  best_check_score: number | null;
  updated_at: string;
};

export type TopicProgressInsert = Omit<TopicProgressRow, 'updated_at'> & { updated_at?: string };

export type LabResultRow = {
  id: number;
  user_id: string;
  lab_id: string;
  course_slug: string;
  level: LabLevel;
  passed: boolean;
  score: number;
  hints_used: number;
  duration_s: number | null;
  checks: unknown;
  artifact: unknown;
  client_attempt_id: string | null;
  created_at: string;
};

export type LabResultInsert = Omit<LabResultRow, 'id' | 'created_at' | 'duration_s' | 'artifact'> & {
  duration_s?: number | null;
  artifact?: unknown;
};

export type CheckAttemptRow = {
  id: number;
  user_id: string;
  course_slug: string;
  unit_index: number;
  topic_index: number | null;
  score: number;
  passed: boolean;
  answers: unknown;
  client_attempt_id: string | null;
  created_at: string;
};

export type CheckAttemptInsert = Omit<CheckAttemptRow, 'id' | 'created_at'>;

export type Database = {
  public: {
    Tables: {
      profiles: { Row: ProfileRow; Insert: ProfileRow; Update: ProfileUpdate; Relationships: [] };
      topic_progress: {
        Row: TopicProgressRow;
        Insert: TopicProgressInsert;
        Update: Partial<TopicProgressRow>;
        Relationships: [];
      };
      lab_results: { Row: LabResultRow; Insert: LabResultInsert; Update: Partial<LabResultRow>; Relationships: [] };
      check_attempts: {
        Row: CheckAttemptRow;
        Insert: CheckAttemptInsert;
        Update: Partial<CheckAttemptRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: { mastery: Mastery; lab_level: LabLevel; age_band: AgeBand; platform_role: PlatformRole };
    CompositeTypes: Record<string, never>;
  };
};
