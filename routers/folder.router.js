const { createFolder, getFolders, getFolderByName, moveToFolder, searchFolders, getFolderSuggestions, editFolder, deleteFolder } = require("../controllers/folder.controller");
const authenticate = require("../middleware/auth.middleware");

const router = require("express").Router();

router.post("/create-folder", authenticate, createFolder);
router.get("/", authenticate, getFolders);
router.get("/:name", authenticate, getFolderByName);
router.post("/move-to-folder", authenticate, moveToFolder);
router.get("/search/folders", authenticate, searchFolders);
router.get("/get-folders/suggestions", authenticate, getFolderSuggestions);
router.put("/editFolder/:id", authenticate, editFolder);
router.delete("/deleteFolder/:id", authenticate, deleteFolder);





module.exports = router;