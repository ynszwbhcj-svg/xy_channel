import { createSchemaTool } from "./schema-tool-factory.js";
import { searchPhotoGalleryTool } from "./search-photo-gallery-tool.js";
import { uploadPhotoTool } from "./upload-photo-tool.js";
import { saveMediaToGalleryTool } from "./save-media-to-gallery-tool.js";

export const getPhotoToolSchemaTool = createSchemaTool({
    name: "get_photo_tool_schema",
    label: "Get Photo Tool Schema",
    description: "获取可在用户设备上搜索图库照片、将照片上传到公网并获取链接、保存图片或视频到图库的相关端工具列表。",
    tools: [searchPhotoGalleryTool, uploadPhotoTool, saveMediaToGalleryTool],
  });
