-- Run AFTER you have logged in to the app once with your phone (that creates your members row).
-- Replace the phone with yours in E.164 format.
update members set roles = array['admin'], name = 'Rock' where phone = '+46701234567';

-- Everyone else: add them in the app — Admin → Settings → "Add a member" (tick Teacher / Crew / Admin).
