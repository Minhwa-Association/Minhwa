-- Run AFTER you have logged in to the app once with your phone (that creates your members row).
-- Replace the phone with yours in E.164 format.
update members set role = 'admin', name = 'Rock' where phone = '+46701234567';

-- Optional: register instructors so they can be assigned to slots in Admin.
-- They also need to log in once (which creates their row), or you can insert them here with a random id
-- (they can be linked later by phone):
-- update members set role = 'instructor', name = 'Teacher A' where phone = '+46...';
