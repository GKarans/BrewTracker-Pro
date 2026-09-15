alter table public.measurements
  add column if not exists process_action_id uuid
    references public.process_actions(id) on delete set null;

alter table public.packaging_runs
  add column if not exists centrifuge_liters numeric(8,1)
    check (centrifuge_liters is null or centrifuge_liters >= 0);

create index if not exists measurements_process_action_id_idx
  on public.measurements (process_action_id);

create index if not exists packaging_runs_batch_filtered_at_idx
  on public.packaging_runs (batch_id, filtered_at);
