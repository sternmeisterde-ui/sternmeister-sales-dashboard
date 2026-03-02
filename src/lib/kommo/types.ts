// Kommo CRM API response types

export interface KommoUser {
  id: number;
  name: string;
  email: string;
  lang: string;
  rights: Record<string, unknown>;
}

export interface KommoEvent {
  id: number;
  type: string;
  entity_id: number;
  entity_type: string;
  created_by: number;
  created_at: number;
  value_after: Array<{
    note?: {
      id: number;
      params?: {
        duration?: number;
        uniq?: string;
        source?: string;
        call_status?: number; // 1=left_msg 2=callback_later 3=no_answer 4=answered 5=busy 6=wrong_num 7=phone_off
        phone?: string;
        link?: string;
      };
    };
  }>;
  value_before: unknown[];
  account_id: number;
}

export interface KommoLead {
  id: number;
  name: string;
  price: number;
  responsible_user_id: number;
  group_id: number;
  status_id: number;
  pipeline_id: number;
  loss_reason_id: number | null;
  created_by: number;
  updated_by: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  closest_task_at: number | null;
  is_deleted: boolean;
  custom_fields_values: Array<{
    field_id: number;
    field_name: string;
    field_code: string | null;
    field_type: string;
    values: Array<{ value: unknown; enum_id?: number; enum_code?: string }>;
  }> | null;
  score: number | null;
  account_id: number;
  _links: { self: { href: string } };
  _embedded?: {
    tags?: Array<{ id: number; name: string }>;
    companies?: Array<{ id: number }>;
    contacts?: Array<{ id: number; is_main: boolean }>;
  };
}

export interface KommoTask {
  id: number;
  created_by: number;
  updated_by: number;
  created_at: number;
  updated_at: number;
  responsible_user_id: number;
  group_id: number;
  entity_id: number;
  entity_type: string;
  is_completed: boolean;
  task_type_id: number;
  text: string;
  duration: number;
  complete_till: number;
  result: unknown;
  account_id: number;
}

export interface KommoPipeline {
  id: number;
  name: string;
  sort: number;
  is_main: boolean;
  is_unsorted_on: boolean;
  is_archive: boolean;
  account_id: number;
  _embedded: {
    statuses: Array<{
      id: number;
      name: string;
      sort: number;
      is_editable: boolean;
      pipeline_id: number;
      color: string;
      type: number; // 0=normal, 1=won, 2=lost
      account_id: number;
    }>;
  };
}

export interface KommoAccount {
  id: number;
  name: string;
  subdomain: string;
  current_user_id: number;
  country: string;
  currency: string;
  _embedded?: {
    amojo_id?: string;
  };
}

export interface KommoCallNote {
  id: number;
  entity_id: number;
  created_by: number;
  updated_by: number;
  created_at: number;
  updated_at: number;
  responsible_user_id: number;
  group_id: number;
  note_type: "call_out" | "call_in";
  params: {
    uniq?: string;
    duration?: number;
    source?: string;
    link?: string;
    phone?: string;
    call_result?: string;
    call_status?: number; // 1=left_msg 2=callback_later 3=no_answer 4=answered 5=busy 6=wrong_num 7=phone_off
  };
  account_id: number;
}

export interface KommoPaginatedResponse<T> {
  _page: number;
  _links: { self: { href: string }; next?: { href: string } };
  _embedded: Record<string, T[]>;
}
