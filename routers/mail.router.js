const { 
    getEmails, 
    sendEmail, 
    getEmailsByThreadId, 
    moveToTrash, 
    setEmailIsRead, 
    deleteEmail, 
    setEmailStarred, 
    saveDraft, 
    moveMessageToArchive, 
    getEmailByMessageId, 
    restoreFromArchive, 
    moveThreadToArchive, 
    restoreThreadFromArchive, 
    moveThreadToTrash, 
    restoreThreadFromTrash, 
    toggleEmailStarred, 
    moveEmailToSpam, 
    moveThreadToSpam,
    getStarredEmails,
    moveThreadsToArchive,
    restoreThreadsFromArchive,
    moveThreadsToFolder,
    restoreThreadsFromFolder,
    setThreadsReadStatus,
    deleteMultipleThreads,
    getEmailCounts,
    storeEmailInDb,
    storeEmailsInDb,
    deleteDraft,
    deleteDrafts,
    moveMessagesToFolder,
    restoreMessagesFromFolder
} = require("../controllers/email.controller");
const authenticate = require("../middleware/auth.middleware");

const router = require("express").Router();

router.get("/", authenticate ,getEmails);
router.post("/send-mail", authenticate, sendEmail);
router.post("/store-mail-to-db", authenticate, storeEmailInDb);
router.post("/store-emails-to-db", authenticate, storeEmailsInDb);
router.get("/get-emails/:thread_id", authenticate, getEmailsByThreadId)
router.get("/move-to-trash/:messageId", authenticate, moveToTrash);
router.delete("/delete-email/:messageId", authenticate, deleteEmail)
router.post("/set-isread/:thread_id", authenticate, setEmailIsRead);
router.post("/set-starred/:messageId", authenticate, toggleEmailStarred);
router.post("/save-draft", authenticate, saveDraft);
router.put("/add-to-archieve/:messageId", authenticate, moveMessageToArchive);
router.put("/restore-from-archieve/:messageId", authenticate, restoreFromArchive);
router.get('get-email/:messageId', authenticate, getEmailByMessageId);
router.put("/move-thread-to-archive/:threadId", authenticate, moveThreadToArchive);
router.put("/restore-thread-from-archive/:threadId", authenticate, restoreThreadFromArchive);
router.put("/move-thread-to-trash/:threadId", authenticate, moveThreadToTrash);
router.put("/restore-thread-from-trash/:threadId", authenticate, restoreThreadFromTrash);
router.put("/move-email-to-spam", authenticate, moveEmailToSpam);
router.put("/move-thread-to-spam", authenticate, moveThreadToSpam);
router.get("/get-starred-emails", authenticate, getStarredEmails);
router.post("/archive-multiple", authenticate, moveThreadsToArchive);
router.post("/restore-multiple-from-archive", authenticate, restoreThreadsFromArchive);
router.post("/move-multiple-to-folder", authenticate, moveThreadsToFolder);
router.post("/restore-multiple-from-thread", authenticate, restoreThreadsFromFolder);
router.post("/set-multiple-isread", authenticate, setThreadsReadStatus);
router.post("/delete-multiple", authenticate, deleteMultipleThreads);
router.get("/counts", authenticate, getEmailCounts );
router.delete("/delete-draft/:id", authenticate, deleteDraft);
router.post("/delete-drafts", authenticate, deleteDrafts);
router.post("/move-messages-to-folder", authenticate, moveMessagesToFolder);
router.post("/restore-messages-from-folder", authenticate, restoreMessagesFromFolder)

module.exports = router;