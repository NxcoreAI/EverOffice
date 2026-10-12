/** slides 配图过目卡轮询载荷（网关 /v1/slides/page-images/:documentId 响应，与广播同构）。 */
export interface SlidesPageImagesStatus {
  stage: 'page_images_confirm' | 'page_images_review'
  title?: string
  totalPages?: number
  doneCount?: number
  documentId?: string
  generation?: number
  updatedAt?: number
  pages?: Array<{
    title?: string
    imagePrompt?: string
    url?: string
    rejected?: boolean
    failed?: boolean
  }>
}
