-- 下書き配送の dedupe キーを版つき(`id@hash12`)へ変える。改稿の再配送が前の配送の
-- dedupe に潰されないため。drafts_sync_delivery の照合を「dedupe_key 全体 = id」から
-- 「先頭36字(UUID)= id」へ広げる — 旧形式(素の id)は substr でそのまま一致する。
-- 併せて配送確定時に decision_origin_id を空へ戻す(改稿後の新しい版への決定を受け付ける)。

DROP TRIGGER drafts_sync_delivery;

CREATE TRIGGER drafts_sync_delivery
AFTER UPDATE OF state ON discord_outbound
WHEN NEW.state != OLD.state AND NEW.state IN ('sent','failed','partial','unknown')
BEGIN
  UPDATE drafts
     SET outbound_id = COALESCE(outbound_id, NEW.id),
         state = CASE
           WHEN NEW.state = 'sent' AND EXISTS (
             SELECT 1 FROM discord_outbound_actions
              WHERE outbound_id = NEW.id AND kind = 'message' AND state = 'succeeded' AND receipt IS NOT NULL
           ) THEN 'delivered'
           ELSE 'delivery_failed'
         END,
         delivered_at = CASE
           WHEN NEW.state = 'sent' AND EXISTS (
             SELECT 1 FROM discord_outbound_actions
              WHERE outbound_id = NEW.id AND kind = 'message' AND state = 'succeeded' AND receipt IS NOT NULL
           ) THEN NEW.updated_at
           ELSE NULL
         END,
         review_feedback = CASE WHEN NEW.state = 'sent' THEN review_feedback ELSE NEW.error END,
         decision_origin_id = NULL,
         updated_at = NEW.updated_at
   WHERE state IN ('review_pending','delivery_pending')
     AND (outbound_id = NEW.id OR (outbound_id IS NULL AND NEW.purpose = 'assistant-draft'
          AND id = substr(NEW.dedupe_key, 1, 36)));
  INSERT OR REPLACE INTO schema_meta(key,value)
    SELECT 'health:draft:last_success',NEW.updated_at
     WHERE EXISTS (SELECT 1 FROM drafts WHERE outbound_id=NEW.id AND state='delivered');
  INSERT OR REPLACE INTO schema_meta(key,value)
    SELECT 'health:draft:last_failure',json_object('at',NEW.updated_at,'stage','delivery','error',NEW.error)
     WHERE NEW.state IN ('failed','partial','unknown')
       AND EXISTS (SELECT 1 FROM drafts WHERE outbound_id=NEW.id AND state='delivery_failed');
END;
