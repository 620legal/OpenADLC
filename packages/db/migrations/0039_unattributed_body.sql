-- The body a post by a crew account had when its signature did not check.
--
-- Each health run reads the post again and resolves its record when it
-- verifies now. Nothing tied that to the body that was recorded, so a post
-- made around FleetADLC's gh and then edited to a body stamped for its seat
-- verified, and the edit erased the incident. A record is resolved only while
-- the body GitHub has is still the one recorded here (`sha256` of it).
alter table unattributed_posts add column if not exists body_sha256 text;
